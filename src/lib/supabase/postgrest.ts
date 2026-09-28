// Server-only: how the Next server reaches the private PostgREST.
//
// Two credentials ride on every request (docs/firebase-migration.md §3.2):
//
//   X-Serverless-Authorization  Google ID token. PostgREST runs on Cloud
//                               Run with IAM on; only service accounts
//                               with run.invoker get through.
//   Authorization               Short-lived HS256 JWT PostgREST verifies
//                               with PGRST_JWT_SECRET. Its `role` picks the
//                               Postgres role (authenticated / service_role)
//                               and its `sub` is what auth.uid() returns.
//                               No JWT → PostgREST runs the query as `anon`.
//
// Env:
//   POSTGREST_URL                Cloud Run URL of the postgrest service
//   POSTGREST_JWT_SECRET         same value as the pgrst-jwt-secret secret
//   POSTGREST_ID_TOKEN_COMMAND   local dev only: a command that prints a
//                                Google ID token for a service account with
//                                run.invoker, audience = POSTGREST_URL
//                                (`gcloud auth print-identity-token
//                                --impersonate-service-account=… --audiences=…`;
//                                see .env.local.example). On Cloud Run the
//                                metadata server is used.

import { createHmac } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

export type PostgrestClaims =
  | { role: "authenticated"; sub: string }
  | { role: "service_role" };

/** Lifetime of the app JWT. Minted per request, so it only has to
 *  outlive one round trip. */
const JWT_TTL_SECONDS = 60;

export function postgrestUrl(): string {
  const url = process.env.POSTGREST_URL;
  if (!url) throw new Error("POSTGREST_URL is not set");
  return url.replace(/\/+$/, "");
}

export function mintPostgrestJwt(claims: PostgrestClaims, now = Date.now()): string {
  const secret = process.env.POSTGREST_JWT_SECRET;
  if (!secret) throw new Error("POSTGREST_JWT_SECRET is not set");
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ aud: "authenticated", iat, exp: iat + JWT_TTL_SECONDS, ...claims }),
  );
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

// ------------------------------------------------------------------
// Google ID token for Cloud Run IAM
// ------------------------------------------------------------------

let idToken: { value: string; expiresAt: number } | null = null;
let idTokenInFlight: Promise<string | null> | null = null;

/** Refresh this long before Google's expiry (tokens live ~1h). */
const ID_TOKEN_MARGIN_MS = 5 * 60_000;

async function fetchIdToken(audience: string): Promise<string | null> {
  if (process.env.K_SERVICE) {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity" +
        `?audience=${encodeURIComponent(audience)}`,
      { headers: { "Metadata-Flavor": "Google" }, cache: "no-store" },
    );
    if (!res.ok) throw new Error(`metadata server returned ${res.status} for the ID token`);
    return (await res.text()).trim();
  }
  const command = process.env.POSTGREST_ID_TOKEN_COMMAND;
  if (command) {
    const { stdout } = await promisify(exec)(command, { timeout: 20_000 });
    return stdout.trim();
  }
  // A PostgREST without IAM in front (e.g. a local container).
  return null;
}

function expiryOf(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    // fall through
  }
  return Date.now() + 10 * 60_000;
}

export async function googleIdToken(audience: string): Promise<string | null> {
  if (idToken && idToken.expiresAt - ID_TOKEN_MARGIN_MS > Date.now()) return idToken.value;
  idTokenInFlight ??= fetchIdToken(audience)
    .then((value) => {
      idToken = value ? { value, expiresAt: expiryOf(value) } : null;
      return value;
    })
    .finally(() => {
      idTokenInFlight = null;
    });
  return idTokenInFlight;
}

// ------------------------------------------------------------------
// fetch that signs every request
// ------------------------------------------------------------------

/**
 * A `fetch` for PostgrestClient that attaches both credentials. The
 * claims are resolved per request (not once per client) so a long
 * server task — a broadcast, an automation run — never sends a JWT
 * that expired mid-way.
 */
export function signedPostgrestFetch(
  claims: () => Promise<PostgrestClaims | null>,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    const [resolved, token] = await Promise.all([claims(), googleIdToken(postgrestUrl())]);
    if (resolved) headers.set("Authorization", `Bearer ${mintPostgrestJwt(resolved)}`);
    else headers.delete("Authorization");
    if (token) headers.set("X-Serverless-Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers, cache: "no-store" });
  };
}
