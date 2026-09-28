// Server-only: `supabaseAdmin().storage` on Cloud Storage.
//
// The service-role half of Storage — today only the inbound media
// mirror in the WhatsApp webhook. It talks to the Cloud Storage JSON API
// with the server's Google credential (the same one firebase-admin uses,
// see src/lib/auth/firebase-admin.ts), so storage.rules don't apply,
// just as RLS didn't apply to Supabase's service role. The bucket
// limits still did on Supabase, so they are checked here
// (src/lib/storage/buckets.ts).
//
// REST rather than @google-cloud/storage: firebase-admin's Storage
// wrapper only accepts a service-account key or ADC, and local dev
// signs in with a gcloud access token.

import { googleAccessToken } from "@/lib/auth/firebase-admin";
import type { StorageBucket, StorageClient, StorageError } from "@/lib/supabase/app-client";
import {
  cacheControlHeader,
  objectName,
  publicObjectUrl,
  storageBucketName,
  uploadRejection,
} from "./buckets";

const API = "https://storage.googleapis.com";

type Body = Parameters<StorageBucket["upload"]>[1];

function toBlob(body: Body): Blob {
  if (body instanceof Blob) return body;
  const bytes =
    body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Blob([bytes as Uint8Array<ArrayBuffer>]);
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { authorization: `Bearer ${await googleAccessToken()}` };
  // A user token (local dev) bills the quota project, as firebase-admin does.
  const quotaProject = process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
  if (quotaProject) headers["x-goog-user-project"] = quotaProject;
  return headers;
}

async function apiError(res: Response, fallback: string): Promise<StorageError> {
  if (res.status === 412) return { message: "The resource already exists" };
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { message: body?.error?.message ?? `${fallback} (${res.status})` };
}

function bucket(name: string): StorageBucket {
  return {
    async upload(path, body, options = {}) {
      const blob = toBlob(body);
      const contentType = options.contentType ?? (blob.type || "application/octet-stream");
      const rejection = uploadRejection(name, blob.size, contentType);
      if (rejection) return { data: null, error: { message: rejection } };

      const metadata = {
        name: objectName(name, path),
        contentType,
        cacheControl: cacheControlHeader(options.cacheControl),
      };
      const boundary = `wacrm-${crypto.randomUUID()}`;
      const multipart = new Blob([
        `--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n`,
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--\r\n`,
      ]);

      const query = new URLSearchParams({ uploadType: "multipart" });
      // upsert: false → only create; an existing object is a conflict.
      if (!options.upsert) query.set("ifGenerationMatch", "0");

      try {
        const res = await fetch(
          `${API}/upload/storage/v1/b/${encodeURIComponent(storageBucketName())}/o?${query}`,
          {
            method: "POST",
            headers: {
              ...(await authHeaders()),
              "content-type": `multipart/related; boundary=${boundary}`,
            },
            body: multipart,
          },
        );
        if (!res.ok) return { data: null, error: await apiError(res, "Upload failed") };
        return { data: { path }, error: null };
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    },

    getPublicUrl(path) {
      return { data: { publicUrl: publicObjectUrl(name, path) } };
    },

    async remove(paths) {
      try {
        const headers = await authHeaders();
        const removed: Array<{ name: string }> = [];
        for (const path of paths) {
          const object = objectName(name, path);
          const res = await fetch(
            `${API}/storage/v1/b/${encodeURIComponent(storageBucketName())}/o/${encodeURIComponent(object)}`,
            { method: "DELETE", headers },
          );
          // Like Supabase, removing something that isn't there is not an error.
          if (!res.ok && res.status !== 404) {
            return { data: null, error: await apiError(res, "Delete failed") };
          }
          if (res.ok) removed.push({ name: path });
        }
        return { data: removed, error: null };
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    },
  };
}

export const adminStorage: StorageClient = { from: bucket };
