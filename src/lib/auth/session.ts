// Server-only: the Firebase session cookie → the auth.users row.
//
// Login (phase 2) exchanges a Firebase ID token for a session cookie
// (firebase-admin `createSessionCookie`) and stores it as `__session` —
// the only cookie name Firebase Hosting forwards to Cloud Run. Every
// server entry point reads it back through here.
//
// Verification is local (signature + expiry against Google's cached
// public keys); it doesn't check revocation, same trade-off as
// Supabase's JWT sessions. The Firebase UID is then mapped to the uuid
// in auth.users that RLS keys on (docs/firebase-migration.md §3.3).

import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

import type { User } from "@/lib/supabase/app-client";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const SESSION_COOKIE = "__session";

function firebaseAuth() {
  const app =
    getApps()[0] ??
    initializeApp({
      projectId:
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT,
    });
  return getAuth(app);
}

/** The decoded cookie, or null when it is missing, forged or expired. */
export async function verifySessionCookie(
  cookie: string | undefined,
): Promise<DecodedIdToken | null> {
  if (!cookie) return null;
  try {
    return await firebaseAuth().verifySessionCookie(cookie);
  } catch {
    return null;
  }
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

async function lookupUser(firebaseUid: string): Promise<User | null> {
  const cached = userCache.get(firebaseUid);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const { data, error } = await supabaseAdmin()
    .rpc("auth_user_by_firebase_uid", { p_firebase_uid: firebaseUid })
    .maybeSingle<AuthUserRow>();
  if (error) throw new Error(`auth user lookup failed: ${error.message}`);
  if (!data) return null;

  const user: User = {
    id: data.id,
    email: data.email ?? undefined,
    user_metadata: data.raw_user_meta_data ?? {},
    app_metadata: data.raw_app_meta_data ?? {},
    created_at: data.created_at,
  };
  if (userCache.size >= USER_CACHE_MAX) userCache.clear();
  userCache.set(firebaseUid, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  return user;
}

/**
 * The signed-in user for a session cookie, or null. A valid cookie
 * whose Firebase user has no auth.users row yet (first login not
 * finished) also resolves to null.
 */
export async function getSessionUser(cookie: string | undefined): Promise<User | null> {
  const decoded = await verifySessionCookie(cookie);
  if (!decoded) return null;
  return lookupUser(decoded.uid);
}
