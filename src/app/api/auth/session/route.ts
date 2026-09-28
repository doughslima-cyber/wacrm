// ============================================================
// /api/auth/session — the browser's session.
//
//   GET     → { user, expiresAt } for the session cookie, or
//             { user: null }. Backs `auth.getUser()` / `getSession()`
//             in the browser client, which can't read the httpOnly
//             cookie itself.
//   POST    { idToken } → sets the session cookie. Called right after
//             a Firebase sign-in, and to renew a cookie close to
//             expiry. See createSession() for what it checks.
//   DELETE  → signs out this browser by clearing the cookie.
//             `?scope=global` also revokes every other session of the
//             user (all devices).
// ============================================================

import { NextResponse, type NextRequest } from "next/server";

import { isSameOrigin } from "@/lib/auth/same-origin";
import {
  createSession,
  getSessionUser,
  revokeAllSessions,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  SessionError,
  verifySessionCookie,
  type SessionRefusal,
} from "@/lib/auth/session";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const REFUSAL_STATUS: Record<SessionRefusal, number> = {
  invalid_token: 401,
  recent_sign_in_required: 401,
  email_not_verified: 403,
  email_in_use: 409,
};

function cookieOptions(request: NextRequest, maxAge: number) {
  return {
    path: "/",
    maxAge,
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax" as const,
  };
}

function clientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  return xff?.split(",")[0].trim() || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function GET(request: NextRequest) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  try {
    const user = await getSessionUser(cookie);
    // The browser renews its cookie (POST) when this gets close.
    const expiresAt = user ? ((await verifySessionCookie(cookie))?.exp ?? 0) * 1000 : null;
    return NextResponse.json(
      { user, expiresAt },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (err) {
    console.error("[auth/session] lookup failed:", err);
    return NextResponse.json({ user: null, error: "session_lookup_failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // Login CSRF: another site must not be able to sign this browser
  // into an account of its choosing.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "cross_origin" }, { status: 403 });
  }
  const limit = checkRateLimit(`session:${clientIp(request)}`, RATE_LIMITS.sessionCreate);
  if (!limit.success) return rateLimitResponse(limit);

  const body = (await request.json().catch(() => null)) as { idToken?: unknown } | null;
  if (typeof body?.idToken !== "string" || !body.idToken) {
    return NextResponse.json({ error: "invalid_token" }, { status: 400 });
  }

  try {
    const session = await createSession(body.idToken, request.cookies.get(SESSION_COOKIE)?.value);
    const response = NextResponse.json({
      user: session.user,
      claimsChanged: session.claimsChanged,
    });
    response.cookies.set(SESSION_COOKIE, session.cookie, cookieOptions(request, SESSION_MAX_AGE_SECONDS));
    return response;
  } catch (err) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.code }, { status: REFUSAL_STATUS[err.code] });
    }
    console.error("[auth/session] sign-in failed:", err);
    return NextResponse.json({ error: "session_create_failed" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "cross_origin" }, { status: 403 });
  }
  const scope = request.nextUrl.searchParams.get("scope") ?? "local";
  if (scope !== "local" && scope !== "global") {
    return NextResponse.json({ error: "unsupported_scope" }, { status: 400 });
  }

  if (scope === "global") {
    const decoded = await verifySessionCookie(request.cookies.get(SESSION_COOKIE)?.value).catch(
      () => null,
    );
    if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      await revokeAllSessions(decoded.uid);
    } catch (err) {
      console.error("[auth/session] revoke failed:", err);
      return NextResponse.json({ error: "revoke_failed" }, { status: 500 });
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", cookieOptions(request, 0));
  return response;
}
