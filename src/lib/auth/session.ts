// Server-only: the Firebase session cookie ↔ the auth.users row.
//
// Signing in exchanges a Firebase ID token for a session cookie
// (`createSession`, behind POST /api/auth/session) stored as
// `__session` — the only cookie name Firebase Hosting forwards to
// Cloud Run. Every server entry point reads it back through here.
//
// The cookie's signature and expiry are checked locally against
// Google's public keys; revocation ("sign out everywhere", a password
// change, a disabled user) against the cached Firebase user record
// (firebase-admin.ts).
//
// The Firebase UID is then mapped to the uuid in auth.users that RLS
// keys on (docs/firebase-migration.md §3.3).

import type { DecodedIdToken } from "firebase-admin/auth";

import type { User } from "@/lib/supabase/app-client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { syncAccountClaims } from "./claims";
import {
  firebaseAuth,
  firebaseUserState,
  forgetFirebaseUser,
  type FirebaseUserState,
} from "./firebase-admin";

export const SESSION_COOKIE = "__session";

/** Firebase's ceiling for a session cookie. */
export const SESSION_MAX_AGE_SECONDS = 14 * 24 * 3600;

/** A fresh sign-in may mint a session only with an ID token this new;
 *  an older one needs a live session of the same user (a renewal). */
const RECENT_SIGN_IN_SECONDS = 5 * 60;

function isRevoked(decoded: DecodedIdToken, state: FirebaseUserState | null): boolean {
  if (!state || state.disabled) return true;
  return decoded.auth_time * 1000 < state.validSinceMs;
}

// ------------------------------------------------------------------
// Reading a session
// ------------------------------------------------------------------

/** The decoded cookie, or null when it is missing, forged, expired or revoked. */
export async function verifySessionCookie(
  cookie: string | undefined,
): Promise<DecodedIdToken | null> {
  if (!cookie) return null;
  let decoded: DecodedIdToken;
  try {
    decoded = await firebaseAuth().verifySessionCookie(cookie);
  } catch {
    return null;
  }
  return isRevoked(decoded, await firebaseUserState(decoded.uid)) ? null : decoded;
}

// The Firebase UID → auth.users mapping never changes for a user, so a
// short in-process cache saves a PostgREST round trip per request.
const USER_CACHE_TTL_MS = 60_000;
const USER_CACHE_MAX = 1_000;
const userCache = new Map<string, { user: User; expiresAt: number }>();

interface AuthUserRow {
  id: string;
  email: string | null;
  raw_user_meta_data: Record<string, unknown> | null;
  raw_app_meta_data: Record<string, unknown> | null;
  created_at: string;
}

function toUser(row: AuthUserRow): User {
  return {
    id: row.id,
    email: row.email ?? undefined,
    user_metadata: row.raw_user_meta_data ?? {},
    app_metadata: row.raw_app_meta_data ?? {},
    created_at: row.created_at,
  };
}

function cacheUser(firebaseUid: string, user: User) {
  if (userCache.size >= USER_CACHE_MAX) userCache.clear();
  userCache.set(firebaseUid, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
}

async function lookupUser(firebaseUid: string): Promise<User | null> {
  const cached = userCache.get(firebaseUid);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const { data, error } = await supabaseAdmin()
    .rpc("auth_user_by_firebase_uid", { p_firebase_uid: firebaseUid })
    .maybeSingle<AuthUserRow>();
  if (error) throw new Error(`auth user lookup failed: ${error.message}`);
  if (!data) return null;

  const user = toUser(data);
  cacheUser(firebaseUid, user);
  return user;
}

/**
 * The signed-in user for a session cookie, or null. A valid cookie
 * whose Firebase user has no auth.users row (it was deleted) also
 * resolves to null.
 */
export async function getSessionUser(cookie: string | undefined): Promise<User | null> {
  const decoded = await verifySessionCookie(cookie);
  if (!decoded) return null;
  return lookupUser(decoded.uid);
}

// ------------------------------------------------------------------
// Creating and ending sessions
// ------------------------------------------------------------------

export type SessionRefusal =
  | "invalid_token"
  | "email_not_verified"
  | "recent_sign_in_required"
  | "email_in_use";

export class SessionError extends Error {
  constructor(readonly code: SessionRefusal) {
    super(code);
  }
}

export interface CreatedSession {
  cookie: string;
  user: User;
  /** The custom claims changed: the browser must refresh its ID token
   *  before Storage / Firestore rules see the new account. */
  claimsChanged: boolean;
}

/**
 * ID token → session cookie. What Supabase's GoTrue did on sign-in:
 * refuses unverified emails, creates the auth.users row on the first
 * sign-in (the upstream trigger then creates profile and account),
 * and stamps the account ids into the custom claims.
 *
 * `currentCookie` lets a still-signed-in browser renew its cookie with
 * an ID token whose sign-in is older than RECENT_SIGN_IN_SECONDS.
 */
export async function createSession(
  idToken: string,
  currentCookie: string | undefined,
): Promise<CreatedSession> {
  let decoded: DecodedIdToken;
  try {
    decoded = await firebaseAuth().verifyIdToken(idToken, true);
  } catch {
    throw new SessionError("invalid_token");
  }
  if (!decoded.email || !decoded.email_verified) throw new SessionError("email_not_verified");

  const recent = Date.now() / 1000 - decoded.auth_time <= RECENT_SIGN_IN_SECONDS;
  if (!recent && (await verifySessionCookie(currentCookie))?.uid !== decoded.uid) {
    throw new SessionError("recent_sign_in_required");
  }

  const { data, error } = await supabaseAdmin()
    .rpc("auth_sync_user", {
      p_firebase_uid: decoded.uid,
      p_email: decoded.email,
      p_email_verified: true,
      p_full_name: typeof decoded.name === "string" ? decoded.name : "",
    })
    .single<AuthUserRow>();
  if (error?.code === "23505") throw new SessionError("email_in_use");
  if (error || !data) throw new Error(`auth user sync failed: ${error?.message ?? "no row"}`);
  const user = toUser(data);
  cacheUser(decoded.uid, user);

  const claimsChanged = await syncAccountClaims(decoded.uid, user.id);
  const cookie = await firebaseAuth().createSessionCookie(idToken, {
    expiresIn: SESSION_MAX_AGE_SECONDS * 1000,
  });
  return { cookie, user, claimsChanged };
}

/**
 * Ends every session of the user, on every device: their refresh
 * tokens stop working and cookies minted before now fail the
 * revocation check.
 */
export async function revokeAllSessions(uid: string): Promise<void> {
  await firebaseAuth().revokeRefreshTokens(uid);
  forgetFirebaseUser(uid);
  userCache.delete(uid);
}
