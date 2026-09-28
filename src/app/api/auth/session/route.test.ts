import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const createSession = vi.fn();
const revokeAllSessions = vi.fn();
const verifySessionCookie = vi.fn();

vi.mock("@/lib/auth/session", async () => {
  class SessionError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    SESSION_COOKIE: "__session",
    SESSION_MAX_AGE_SECONDS: 1209600,
    SessionError,
    createSession: (...args: unknown[]) => createSession(...args),
    revokeAllSessions: (...args: unknown[]) => revokeAllSessions(...args),
    verifySessionCookie: (...args: unknown[]) => verifySessionCookie(...args),
    getSessionUser: async () => null,
  };
});

const { POST, DELETE } = await import("./route");
const { SessionError } = await import("@/lib/auth/session");

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://app.test/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", host: "app.test", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/auth/session", () => {
  it("sets an httpOnly session cookie for a valid ID token", async () => {
    createSession.mockResolvedValue({ cookie: "c1", user: { id: "u1" }, claimsChanged: true });
    const res = await POST(post({ idToken: "t1" }, { "x-forwarded-for": "10.0.0.1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: "u1" }, claimsChanged: true });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__session=c1");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Secure/i);
  });

  it("refuses a cross-site request (login CSRF)", async () => {
    const res = await POST(post({ idToken: "t1" }, { origin: "https://evil.test", "x-forwarded-for": "10.0.0.2" }));
    expect(res.status).toBe(403);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects a body without an ID token", async () => {
    const res = await POST(post({}, { "x-forwarded-for": "10.0.0.3" }));
    expect(res.status).toBe(400);
  });

  it.each([
    ["email_not_verified", 403],
    ["recent_sign_in_required", 401],
    ["invalid_token", 401],
    ["email_in_use", 409],
  ])("maps %s to %i without setting a cookie", async (code, status) => {
    createSession.mockRejectedValue(new SessionError(code as never));
    const res = await POST(post({ idToken: "t" }, { "x-forwarded-for": `10.0.1.${status}` }));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("DELETE /api/auth/session", () => {
  function del(scope?: string, cookie?: string) {
    const req = new NextRequest(
      `https://app.test/api/auth/session${scope ? `?scope=${scope}` : ""}`,
      { method: "DELETE", headers: { host: "app.test" } },
    );
    if (cookie) req.cookies.set("__session", cookie);
    return req;
  }

  it("clears the cookie", async () => {
    const res = await DELETE(del());
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/__session=;.*Max-Age=0/i);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it("scope=global revokes every session of the signed-in user", async () => {
    verifySessionCookie.mockResolvedValue({ uid: "fb-1" });
    const res = await DELETE(del("global", "c1"));
    expect(res.status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith("fb-1");
  });

  it("scope=global without a live session is 401", async () => {
    verifySessionCookie.mockResolvedValue(null);
    const res = await DELETE(del("global"));
    expect(res.status).toBe(401);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });
});
