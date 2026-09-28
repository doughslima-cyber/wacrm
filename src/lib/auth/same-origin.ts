import type { NextRequest } from "next/server";

/**
 * Cookie auth invites CSRF on writes. SameSite=Lax already blocks the
 * cross-site cases browsers can build; this also refuses any request a
 * browser labels as cross-site, or whose Origin isn't this host.
 */
export function isSameOrigin(request: NextRequest): boolean {
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
