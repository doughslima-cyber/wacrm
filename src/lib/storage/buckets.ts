// The three media "buckets" and their limits.
//
// On Supabase these were real buckets whose `file_size_limit` and
// `allowed_mime_types` lived in the migrations (008, 016, 023, 039).
// On Firebase they are top-level prefixes of the project's default
// Cloud Storage bucket (docs/firebase-migration.md, phase 3):
//
//   <default bucket>/avatars/<user uuid>/...
//   <default bucket>/flow-media/account-<account uuid>/...
//   <default bucket>/chat-media/account-<account uuid>/...
//
// The limits are enforced in three places, all fed by the same numbers:
// storage.rules (browser uploads), the browser adapter (to give a clear
// error before the rules refuse), and the service-role adapter (the
// Admin API bypasses the rules). `buckets.test.ts` fails when
// storage.rules drifts from this file.
//
// Isomorphic: pure data, safe to import anywhere.

export type BucketName = "avatars" | "flow-media" | "chat-media";

export interface BucketConfig {
  maxBytes: number;
  mimeTypes: readonly string[];
}

const MB = 1024 * 1024;

const IMAGES = ["image/png", "image/jpeg", "image/webp"] as const;
const VIDEOS = ["video/mp4", "video/3gpp"] as const;
const DOCUMENTS = [
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
] as const;
const AUDIO = ["audio/ogg", "audio/mpeg", "audio/aac", "audio/mp4", "audio/amr"] as const;

export const BUCKETS: Record<BucketName, BucketConfig> = {
  // Migration 008.
  avatars: {
    maxBytes: 2 * MB,
    mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  },
  // Migration 016.
  "flow-media": {
    maxBytes: 16 * MB,
    mimeTypes: [...IMAGES, ...VIDEOS, ...DOCUMENTS],
  },
  // Migration 023, widened by 039 for what inbound WhatsApp media
  // arrives as (GIFs, QuickTime, Meta's `video/3gp`, `audio/opus`).
  "chat-media": {
    maxBytes: 16 * MB,
    mimeTypes: [
      ...IMAGES,
      "image/gif",
      ...VIDEOS,
      "video/3gp",
      "video/quicktime",
      ...DOCUMENTS,
      ...AUDIO,
      "audio/opus",
    ],
  },
};

export function bucketConfig(bucket: string): BucketConfig | null {
  return Object.hasOwn(BUCKETS, bucket) ? BUCKETS[bucket as BucketName] : null;
}

/**
 * Why an upload would be refused, in the words Supabase Storage used,
 * or null when it fits the bucket. The MIME type is compared exactly,
 * as Supabase did: callers normalise it first (see
 * `normalizeMimeType` in the inbound mirror).
 */
export function uploadRejection(bucket: string, size: number, contentType: string): string | null {
  const config = bucketConfig(bucket);
  if (!config) return `Bucket not found: ${bucket}`;
  if (size > config.maxBytes) return "The object exceeded the maximum allowed size";
  if (!config.mimeTypes.includes(contentType)) return `mime type ${contentType || "(none)"} is not supported`;
  return null;
}

/** supabase-js took seconds ("3600"); Cloud Storage wants the header value. */
export function cacheControlHeader(value: string | undefined): string {
  const seconds = value ?? "3600";
  return /^\d+$/.test(seconds) ? `public, max-age=${seconds}` : seconds;
}

// ------------------------------------------------------------------
// Where the objects live
// ------------------------------------------------------------------

/**
 * The Cloud Storage for Firebase bucket, as the Firebase console's web
 * app config names it (`storageBucket`). Required rather than derived
 * from the project id: older projects' default bucket is
 * `<project>.appspot.com`, newer ones' `<project>.firebasestorage.app`,
 * and guessing wrong would address a bucket that doesn't exist.
 */
export function storageBucketName(): string {
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!bucket) throw new Error("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set");
  return bucket;
}

/** `<bucket>/<path>` → the object name inside the default bucket. */
export function objectName(bucket: string, path: string): string {
  return `${bucket}/${path.replace(/^\/+/, "")}`;
}

/**
 * The permanent public URL of an object — the equivalent of Supabase's
 * `getPublicUrl`. It has no download token: the rules let anyone read
 * the three prefixes (as the public buckets did), which is also what
 * lets Meta fetch outbound media at send time.
 */
export function publicObjectUrl(bucket: string, path: string): string {
  return (
    `https://firebasestorage.googleapis.com/v0/b/${storageBucketName()}` +
    `/o/${encodeURIComponent(objectName(bucket, path))}?alt=media`
  );
}
