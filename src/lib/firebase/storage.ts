// Browser-only: uploads and deletes on Cloud Storage for Firebase,
// behind the supabase-js-shaped `storage` of the browser client
// (src/lib/supabase/client.ts, which loads this on first use).
//
// storage.rules authorize each write by the Firebase ID token: an
// account folder needs the account in the `accountIds` claim, an
// avatar folder needs the user's uuid in the `userId` claim
// (src/lib/auth/claims.ts). The SDK stays signed in next to the
// session cookie for exactly this (src/lib/firebase/client.ts).

import { deleteObject, getStorage, ref, uploadBytes, type FirebaseStorage } from "firebase/storage";

import type { StorageBucket, StorageError } from "@/lib/supabase/app-client";
import {
  cacheControlHeader,
  objectName,
  storageBucketName,
  uploadRejection,
} from "@/lib/storage/buckets";
import { firebaseApp, firebaseAuth } from "./client";

type Body = Parameters<StorageBucket["upload"]>[1];
type UploadOptions = Parameters<StorageBucket["upload"]>[2];

let storage: FirebaseStorage | undefined;

function firebaseStorage(): FirebaseStorage {
  return (storage ??= getStorage(firebaseApp(), `gs://${storageBucketName()}`));
}

function toUploadable(body: Body): Blob | Uint8Array | ArrayBuffer {
  if (body instanceof Blob || body instanceof ArrayBuffer) return body;
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function sizeOf(body: Blob | Uint8Array | ArrayBuffer): number {
  return body instanceof Blob ? body.size : body.byteLength;
}

const code = (err: unknown) => (err as { code?: string })?.code;

function toStorageError(err: unknown): StorageError {
  switch (code(err)) {
    case "storage/unauthorized":
      return { message: "You don't have permission to upload here. Reload the page and try again." };
    case "storage/retry-limit-exceeded":
    case "storage/canceled":
      return { message: "The upload didn't finish. Check your connection and try again." };
    case "storage/quota-exceeded":
      return { message: "File storage is full. Contact your administrator." };
    default:
      console.error("[storage]", err);
      return { message: (err as Error)?.message || "Upload failed." };
  }
}

async function signedInUser() {
  const auth = firebaseAuth();
  await auth.authStateReady();
  return auth.currentUser;
}

const NOT_SIGNED_IN: StorageError = { message: "Sign in again to upload files." };

/**
 * `upsert` is not enforced: an upload always writes. Every caller that
 * passes `upsert: false` puts a timestamp in the path, so there is
 * nothing to overwrite.
 */
export async function upload(
  bucket: string,
  path: string,
  body: Body,
  options: UploadOptions = {},
): Promise<{ data: { path: string } | null; error: StorageError | null }> {
  const data = toUploadable(body);
  const contentType =
    options.contentType ?? ((data instanceof Blob && data.type) || "application/octet-stream");
  // The rules would refuse these too, but only with a bare "unauthorized".
  const rejection = uploadRejection(bucket, sizeOf(data), contentType);
  if (rejection) return { data: null, error: { message: rejection } };

  const user = await signedInUser();
  if (!user) return { data: null, error: NOT_SIGNED_IN };

  const target = ref(firebaseStorage(), objectName(bucket, path));
  const metadata = { contentType, cacheControl: cacheControlHeader(options.cacheControl) };
  try {
    await uploadBytes(target, data, metadata);
  } catch (err) {
    if (code(err) !== "storage/unauthorized") return { data: null, error: toStorageError(err) };
    // The token may predate a claim change (joined an account a moment
    // ago, from another tab): refresh it once and try again.
    try {
      await user.getIdToken(true);
      await uploadBytes(target, data, metadata);
    } catch (again) {
      return { data: null, error: toStorageError(again) };
    }
  }
  return { data: { path }, error: null };
}

export async function remove(
  bucket: string,
  paths: string[],
): Promise<{ data: Array<{ name: string }> | null; error: StorageError | null }> {
  if (!(await signedInUser())) return { data: null, error: NOT_SIGNED_IN };
  const removed: Array<{ name: string }> = [];
  for (const path of paths) {
    try {
      await deleteObject(ref(firebaseStorage(), objectName(bucket, path)));
      removed.push({ name: path });
    } catch (err) {
      // Like Supabase, removing something that isn't there is not an error.
      if (code(err) !== "storage/object-not-found") return { data: null, error: toStorageError(err) };
    }
  }
  return { data: removed, error: null };
}
