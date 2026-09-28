// Server-only: the `accountIds` and `userId` custom claims.
//
// Storage and Firestore rules can't query Postgres, so the accounts a
// user belongs to ride in their Firebase ID token as a custom claim
// (docs/firebase-migration.md §3.4). Postgres stays the source of
// truth: this copies profiles.account_id into the claim whenever it
// may have changed — at sign-in, after redeeming an invitation, after
// being removed from an account.
//
// `userId` is the user's auth.users uuid, which is not the Firebase
// UID. storage.rules match it against the avatar folder
// (avatars/<uuid>/…, the path convention of migration 008).
//
// A claim change only reaches a browser when its ID token is next
// refreshed (≤ 1h, or at once when it forces a refresh).

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  firebaseAuth,
  firebaseUserState,
  forgetFirebaseUser,
  rememberCustomClaims,
} from "./firebase-admin";

async function accountIdsOf(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin()
    .from("profiles")
    .select("account_id")
    .eq("user_id", userId)
    .maybeSingle<{ account_id: string | null }>();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return data?.account_id ? [data.account_id] : [];
}

function sameIds(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Writes the claims when they differ. Returns whether they changed. */
export async function syncAccountClaims(firebaseUid: string, userId: string): Promise<boolean> {
  const accountIds = await accountIdsOf(userId);
  // Compare against the live record, not the revocation cache, so a
  // claim another instance wrote a moment ago isn't missed.
  forgetFirebaseUser(firebaseUid);
  const current = (await firebaseUserState(firebaseUid))?.customClaims ?? {};
  if (sameIds(current.accountIds, accountIds) && current.userId === userId) return false;

  const next = { ...current, accountIds, userId };
  await firebaseAuth().setCustomUserClaims(firebaseUid, next);
  rememberCustomClaims(firebaseUid, next);
  return true;
}

/** Same, for a user identified only by their auth.users uuid. */
export async function syncAccountClaimsForUser(userId: string): Promise<boolean> {
  const { data: firebaseUid, error } = await supabaseAdmin().rpc("auth_firebase_uid", {
    p_user_id: userId,
  });
  if (error) throw new Error(`firebase uid lookup failed: ${error.message}`);
  if (typeof firebaseUid !== "string") return false;
  return syncAccountClaims(firebaseUid, userId);
}
