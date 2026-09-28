// Browser-only: the sign-in, sign-up and account flows on Firebase
// Auth, behind the supabase-js-shaped `auth` of the browser client
// (src/lib/supabase/client.ts).
//
// Every flow that signs in ends by handing the ID token to
// POST /api/auth/session, which sets the httpOnly session cookie the
// server reads. Supabase's rules are kept: an unverified email can't
// sign in, and a new account has to confirm its email first.

import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail,
  type ActionCodeSettings,
  type User as FirebaseUser,
} from "firebase/auth";

import type { AuthError, AuthErrorCode, User } from "@/lib/supabase/app-client";
import { firebaseAuth } from "./client";

// Default messages mirror what supabase-js returned; the pages show
// translated ones by code (messages/*.json → AuthErrors).
const MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: "Invalid login credentials",
  email_not_verified: "Email not confirmed",
  email_in_use: "User already registered",
  weak_password: "Password should be at least 6 characters",
  invalid_email: "Unable to validate email address: invalid format",
  too_many_requests: "Too many attempts. Try again in a few minutes.",
  requires_recent_login: "Sign in again to make this change.",
  network: "Network error. Check your connection and try again.",
  session_failed: "Could not start your session. Try again.",
  unknown: "Something went wrong. Try again.",
};

const FIREBASE_CODES: Record<string, AuthErrorCode> = {
  "auth/invalid-credential": "invalid_credentials",
  "auth/invalid-login-credentials": "invalid_credentials",
  "auth/wrong-password": "invalid_credentials",
  "auth/user-not-found": "invalid_credentials",
  "auth/user-disabled": "invalid_credentials",
  "auth/email-already-in-use": "email_in_use",
  "auth/weak-password": "weak_password",
  "auth/password-does-not-meet-requirements": "weak_password",
  "auth/invalid-email": "invalid_email",
  "auth/missing-email": "invalid_email",
  "auth/too-many-requests": "too_many_requests",
  "auth/requires-recent-login": "requires_recent_login",
  "auth/user-token-expired": "requires_recent_login",
  "auth/network-request-failed": "network",
};

export function authError(code: AuthErrorCode, status?: number): AuthError {
  return { code, message: MESSAGES[code], status };
}

export function toAuthError(err: unknown): AuthError {
  const code = (err as { code?: string })?.code;
  const mapped = code ? FIREBASE_CODES[code] : undefined;
  if (!mapped) console.error("[auth]", err);
  return authError(mapped ?? "unknown");
}

class FlowError extends Error {
  constructor(readonly authError: AuthError) {
    super(authError.message);
  }
}

/** Where a link in an auth email sends the user once it's handled. */
function continueTo(url: string): ActionCodeSettings {
  return { url: new URL(url, window.location.origin).toString() };
}

// ------------------------------------------------------------------
// The app session
// ------------------------------------------------------------------

interface SessionResponse {
  user: User;
  claimsChanged: boolean;
}

/** ID token → session cookie (POST /api/auth/session). */
async function startSession(user: FirebaseUser): Promise<User> {
  const res = await fetch("/api/auth/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: await user.getIdToken() }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const code: AuthErrorCode =
      body?.error === "email_not_verified" || body?.error === "email_in_use"
        ? body.error
        : body?.error === "recent_sign_in_required"
          ? "requires_recent_login"
          : res.status === 429
            ? "too_many_requests"
            : "session_failed";
    throw new FlowError(authError(code, res.status));
  }
  const session = (await res.json()) as SessionResponse;
  // New account ids in the claims: refresh the ID token now so
  // Storage / Firestore rules see them.
  if (session.claimsChanged) await user.getIdToken(true).catch(() => {});
  return session.user;
}

async function run<T>(flow: () => Promise<T>): Promise<{ value: T | null; error: AuthError | null }> {
  try {
    return { value: await flow(), error: null };
  } catch (err) {
    return { value: null, error: err instanceof FlowError ? err.authError : toAuthError(err) };
  }
}

// ------------------------------------------------------------------
// Flows
// ------------------------------------------------------------------

export function signIn(email: string, password: string) {
  return run(async () => {
    const auth = firebaseAuth();
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    if (!user.emailVerified) {
      // Same answer as Supabase ("Email not confirmed"), plus a fresh
      // link in case the first one got lost. Firebase throttles
      // repeats; that error is not the user's problem here.
      await sendEmailVerification(user, continueTo(window.location.href)).catch(() => {});
      await signOut(auth);
      throw new FlowError(authError("email_not_verified", 403));
    }
    try {
      return await startSession(user);
    } catch (err) {
      await signOut(auth).catch(() => {});
      throw err;
    }
  });
}

/**
 * Creates the Firebase user and emails the verification link. Like a
 * Supabase signup with confirmations on, nobody is signed in until the
 * email is confirmed; the auth.users row is created at first sign-in.
 */
export function signUp(email: string, password: string, fullName: string, redirectTo?: string) {
  return run(async () => {
    const auth = firebaseAuth();
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    try {
      if (fullName) await updateProfile(user, { displayName: fullName });
      await sendEmailVerification(user, continueTo(redirectTo ?? "/login"));
    } catch (err) {
      // Without the link the account can never be confirmed, and a
      // retry would hit "already registered": undo the sign-up.
      await user.delete().catch(() => {});
      throw err;
    } finally {
      await signOut(auth).catch(() => {});
    }
    return null;
  });
}

export function sendPasswordReset(email: string, redirectTo?: string) {
  return run(async () => {
    try {
      await sendPasswordResetEmail(firebaseAuth(), email, continueTo(redirectTo ?? "/login"));
    } catch (err) {
      // Don't reveal which emails have an account.
      if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
    }
    return null;
  });
}

/**
 * Sets a new password for the signed-in user. Firebase revokes the
 * user's other sessions when the password changes; this browser signs
 * in again with the new password and gets a fresh cookie.
 */
export function changePassword(password: string) {
  return run(async () => {
    const auth = firebaseAuth();
    await auth.authStateReady();
    const user = auth.currentUser;
    if (!user?.email) throw new FlowError(authError("requires_recent_login", 401));
    await updatePassword(user, password);
    const { user: again } = await signInWithEmailAndPassword(auth, user.email, password);
    return startSession(again);
  });
}

/**
 * Emails a confirmation link to the new address; the email changes
 * when it is clicked. That ends the user's sessions (Firebase revokes
 * them on an email change), and the next sign-in with the new address
 * updates auth.users and the profile.
 */
export function changeEmail(email: string) {
  return run(async () => {
    const auth = firebaseAuth();
    await auth.authStateReady();
    const user = auth.currentUser;
    if (!user) throw new FlowError(authError("requires_recent_login", 401));
    await verifyBeforeUpdateEmail(user, email, continueTo("/login"));
    return null;
  });
}

export async function signOutFirebase(): Promise<void> {
  await signOut(firebaseAuth()).catch(() => {});
}

/**
 * Renews the session cookie before it expires (they last 14 days at
 * most), using the SDK's own long-lived sign-in. Quietly does nothing
 * when the SDK isn't signed in as the same user.
 */
export async function renewSession(expectedEmail: string | undefined): Promise<void> {
  const auth = firebaseAuth();
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user || !expectedEmail || user.email?.toLowerCase() !== expectedEmail.toLowerCase()) return;
  await startSession(user).catch(() => {});
}
