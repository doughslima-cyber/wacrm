// ============================================================
// /api/auth/session — the browser's view of its session.
//
//   GET     → { user } for the session cookie, or { user: null }.
//             Backs `auth.getUser()` / `getSession()` in the browser
//             client, which can't read the httpOnly cookie itself.
//   DELETE  → signs out this browser by clearing the cookie.
//
// POST (ID token → session cookie) arrives with Firebase sign-in in
// phase 2 of docs/firebase-migration.md.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";

import { getSessionUser, SESSION_COOKIE } from "@/lib/auth/session";

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    return NextResponse.json({ user });
  } catch (err) {
    console.error("[auth/session] lookup failed:", err);
    return NextResponse.json({ user: null, error: "session_lookup_failed" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  // Ending every device's session means revoking the Firebase refresh
  // tokens and checking revocation on each request — phase 2.
  if (request.nextUrl.searchParams.get("scope") === "global") {
    return NextResponse.json(
      { error: "Signing out other devices is not available yet." },
      { status: 501 },
    );
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
  });
  return response;
}
