// Server-only: the firebase-admin Auth instance.
//
// Verifying tokens and session cookies only needs Google's public
// keys, but minting session cookies, reading users (revocation),
// revoking sessions and writing custom claims call the Identity
// Toolkit API and need a Google credential (the service-role Storage
// adapter borrows the same one):
//
//   Cloud Run   Application Default Credentials (the service account
//               the service runs as; needs roles/firebaseauth.admin,
//               and roles/storage.objectAdmin on the Storage bucket).
//   Local dev   FIREBASE_ADMIN_ACCESS_TOKEN_COMMAND, a command that
//               prints an OAuth access token, e.g.
//               `gcloud auth print-access-token`. A user token also
//               needs GOOGLE_CLOUD_QUOTA_PROJECT (firebase-admin sends
//               it as x-goog-user-project). Without the command, ADC.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { applicationDefault, getApps, initializeApp, type App, type Credential } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

/** gcloud access tokens live 1h; the reported lifetime is kept short
 *  so firebase-admin asks again well before that. */
const COMMAND_TOKEN_SECONDS = 45 * 60;

function commandCredential(command: string): Credential {
  return {
    async getAccessToken() {
      const { stdout } = await promisify(exec)(command, { timeout: 20_000 });
      return { access_token: stdout.trim(), expires_in: COMMAND_TOKEN_SECONDS };
    },
  };
}

export function firebaseProjectId(): string | undefined {
  return process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
}

function firebaseAdminApp(): App {
  const command = process.env.FIREBASE_ADMIN_ACCESS_TOKEN_COMMAND;
  return (
    getApps()[0] ??
    initializeApp({
      projectId: firebaseProjectId(),
      credential: command ? commandCredential(command) : applicationDefault(),
    })
  );
}

export function firebaseAuth(): Auth {
  return getAuth(firebaseAdminApp());
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * An OAuth access token from the same credential, for Google APIs
 * called directly over REST (Cloud Storage, in src/lib/storage/
 * admin-storage.ts). Reused until a minute before it expires, since
 * the local-dev credential shells out to gcloud.
 */
export async function googleAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.value;
  const credential = firebaseAdminApp().options.credential;
  if (!credential) throw new Error("firebase-admin has no credential");
  const { access_token, expires_in } = await credential.getAccessToken();
  cachedToken = { value: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return access_token;
}

// ------------------------------------------------------------------
// The Firebase user record, cached per UID
//
// Every request checks its session for revocation, which needs the
// user record (disabled flag, tokensValidAfterTime). Reading it once
// per UID per FIREBASE_USER_TTL_MS keeps that off the request path: a
// revoked session stops working at once on the instance that revoked
// it, and on every other instance within that window.
// ------------------------------------------------------------------

const FIREBASE_USER_TTL_MS = 60_000;
const FIREBASE_USER_CACHE_MAX = 1_000;

export interface FirebaseUserState {
  disabled: boolean;
  /** Sessions signed in before this (ms since epoch) are revoked. */
  validSinceMs: number;
  customClaims: Record<string, unknown>;
}

// On globalThis: Next can load this module once per layer (route
// handlers, server components), and a revocation done in a route
// must reach the others at once. The proxy is the exception — it runs
// in its own realm (docs: don't rely on shared globals there), so its
// redirects can lag a revocation by up to the TTL; every data path
// (/api/rest, route handlers, server components) refuses at once.
const cacheHolder = globalThis as typeof globalThis & {
  __firebaseUserState?: Map<string, { state: FirebaseUserState; expiresAt: number }>;
};
const userStateCache = (cacheHolder.__firebaseUserState ??= new Map());

/** The user's record, or null when the Firebase user no longer exists. */
export async function firebaseUserState(uid: string): Promise<FirebaseUserState | null> {
  const cached = userStateCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.state;
  try {
    const record = await firebaseAuth().getUser(uid);
    const state: FirebaseUserState = {
      disabled: record.disabled,
      validSinceMs: record.tokensValidAfterTime ? Date.parse(record.tokensValidAfterTime) : 0,
      customClaims: record.customClaims ?? {},
    };
    if (userStateCache.size >= FIREBASE_USER_CACHE_MAX) userStateCache.clear();
    userStateCache.set(uid, { state, expiresAt: Date.now() + FIREBASE_USER_TTL_MS });
    return state;
  } catch (err) {
    if ((err as { code?: string }).code === "auth/user-not-found") return null;
    // Identity Toolkit unreachable: a record seen recently beats
    // signing everyone out; with none, fail closed.
    if (cached) return cached.state;
    throw err;
  }
}

export function rememberCustomClaims(uid: string, customClaims: Record<string, unknown>) {
  const cached = userStateCache.get(uid);
  if (cached) cached.state = { ...cached.state, customClaims };
}

export function forgetFirebaseUser(uid: string) {
  userStateCache.delete(uid);
}
