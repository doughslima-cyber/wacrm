// ============================================================
// /api/rest/* — the browser's door to PostgREST.
//
// The browser client (src/lib/supabase/client.ts) is a plain
// PostgrestClient pointed here. This route:
//   1. resolves the session cookie to the auth.users uuid,
//   2. mints a 60s JWT `{ sub, role: "authenticated" }` for PostgREST,
//   3. forwards method, query string, body and the PostgREST headers
//      (Prefer, Range, …) to the private Cloud Run service,
//   4. streams the answer back.
// RLS does the authorization, exactly as it did behind Supabase.
//
// No cookie → forwarded without a JWT, so PostgREST runs it as `anon`
// (the same thing the anon key did). A cookie that no longer resolves
// → 401, so a dead session fails loudly instead of reading as empty.
// Whatever Authorization header the browser sends is dropped.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";

import { getSessionUser, SESSION_COOKIE } from "@/lib/auth/session";
import { postgrestUrl, signedPostgrestFetch } from "@/lib/supabase/postgrest";

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-profile",
  "content-profile",
  "content-type",
  "prefer",
  "range",
  "range-unit",
];

const FORWARDED_RESPONSE_HEADERS = [
  "content-location",
  "content-range",
  "content-type",
  "location",
  "preference-applied",
];

type RouteContext = { params: Promise<{ path: string[] }> };

function error(status: number, code: string, message: string) {
  return NextResponse.json({ code, message, details: null, hint: null }, { status });
}

/** PostgREST paths are `/<table>` or `/rpc/<function>`; nothing else is exposed. */
function isAllowedPath(path: string[]): boolean {
  if (path.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  if (path.length === 1) return path[0] !== "rpc";
  return path.length === 2 && path[0] === "rpc";
}

/**
 * Cookie auth invites CSRF on writes. SameSite=Lax already blocks the
 * cross-site cases browsers can build; this also refuses any request a
 * browser labels as cross-site, or whose Origin isn't this host.
 */
function isSameOrigin(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function handle(request: NextRequest, { params }: RouteContext) {
  const { path } = await params;
  if (!isAllowedPath(path)) return error(404, "PGRST125", "Invalid path specified in request URL");

  const unsafe = request.method !== "GET" && request.method !== "HEAD";
  if (unsafe && !isSameOrigin(request)) return error(403, "CSRF", "Cross-origin request refused");

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  let userId: string | null = null;
  if (cookie) {
    try {
      userId = (await getSessionUser(cookie))?.id ?? null;
    } catch (err) {
      console.error("[api/rest] session lookup failed:", err);
      return error(503, "SESSION_LOOKUP", "Could not verify the session");
    }
    if (!userId) return error(401, "PGRST301", "Session expired or invalid");
  }

  const upstream = new URL(`${postgrestUrl()}/${path.map(encodeURIComponent).join("/")}`);
  upstream.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstreamFetch = signedPostgrestFetch(async () =>
    userId ? { role: "authenticated", sub: userId } : null,
  );

  let response: Response;
  try {
    response = await upstreamFetch(upstream, {
      method: request.method,
      headers,
      body: unsafe ? await request.arrayBuffer() : undefined,
    });
  } catch (err) {
    console.error("[api/rest] upstream failed:", err);
    return error(502, "UPSTREAM", "Database API unreachable");
  }

  const out = new Headers({ "cache-control": "private, no-store" });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: out });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
