import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// `validCookie` — the only session cookie value the mocked verifier accepts.
const validCookie = "valid-session";

vi.mock("@/lib/auth/session", () => ({
  SESSION_COOKIE: "__session",
  verifySessionCookie: async (cookie: string | undefined) =>
    cookie === validCookie ? { uid: "firebase-uid-1" } : null,
}));

// Imported after the mock is registered.
const { proxy } = await import("./proxy");

afterEach(() => vi.clearAllMocks());

function request(url: string, cookie?: string) {
  const req = new NextRequest(url);
  if (cookie) req.cookies.set("__session", cookie);
  return req;
}

describe("proxy — session-based routing", () => {
  it("redirects a signed-in user off /login to /dashboard", async () => {
    const res = await proxy(request("https://app.test/login", validCookie));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    const res = await proxy(request("https://app.test/login?invite=abc123", validCookie));
    expect(res.headers.get("location")).toContain("/join/abc123");
  });

  it("sends a visitor without a session from a protected page to /login", async () => {
    const res = await proxy(request("https://app.test/inbox"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("treats a forged or expired cookie as signed out", async () => {
    const res = await proxy(request("https://app.test/contacts", "forged"));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    const res = await proxy(request("https://app.test/dashboard", validCookie));
    expect(res.headers.get("location")).toBeNull();
  });

  it("rejects unauthenticated WhatsApp API calls but not the webhook", async () => {
    const api = await proxy(request("https://app.test/api/whatsapp/send"));
    expect(api.status).toBe(401);
    const webhook = await proxy(request("https://app.test/api/whatsapp/webhook"));
    expect(webhook.headers.get("location")).toBeNull();
    expect(webhook.status).toBe(200);
  });
});
