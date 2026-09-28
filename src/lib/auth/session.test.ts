import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- firebase-admin Auth, faked ----------------------------------

interface FakeUser {
  disabled: boolean;
  tokensValidAfterTime?: string;
  customClaims?: Record<string, unknown>;
}

const now = () => Math.floor(Date.now() / 1000);
const users = new Map<string, FakeUser>();
/** token string → decoded payload, for both ID tokens and cookies. */
const tokens = new Map<string, Record<string, unknown>>();

const fakeAuth = {
  verifySessionCookie: vi.fn(async (cookie: string) => {
    const decoded = tokens.get(cookie);
    if (!decoded) throw new Error("bad cookie");
    return decoded;
  }),
  verifyIdToken: vi.fn(async (token: string) => {
    const decoded = tokens.get(token);
    if (!decoded) throw new Error("bad token");
    return decoded;
  }),
  getUser: vi.fn(async (uid: string) => {
    const user = users.get(uid);
    if (!user) throw Object.assign(new Error("nope"), { code: "auth/user-not-found" });
    return user;
  }),
  createSessionCookie: vi.fn(async (token: string) => `cookie-for-${token}`),
  setCustomUserClaims: vi.fn(async (uid: string, claims: Record<string, unknown>) => {
    users.get(uid)!.customClaims = claims;
  }),
  revokeRefreshTokens: vi.fn(async (uid: string) => {
    users.get(uid)!.tokensValidAfterTime = new Date().toUTCString();
  }),
};

vi.mock("firebase-admin/app", () => ({
  getApps: () => [{}],
  initializeApp: () => ({}),
  applicationDefault: () => ({}),
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: () => fakeAuth }));

// ---- service-role PostgREST, faked -------------------------------

const rpc = vi.fn();
let profileAccountId: string | null = "account-1";

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      const result = rpc(fn, args);
      return { maybeSingle: async () => result, single: async () => result };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { account_id: profileAccountId }, error: null }),
        }),
      }),
    }),
  }),
}));

const { createSession, getSessionUser, revokeAllSessions, verifySessionCookie, SessionError } =
  await import("./session");

const ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "a@example.com",
  raw_user_meta_data: { full_name: "A" },
  raw_app_meta_data: {},
  created_at: "2026-09-28T00:00:00Z",
};

let seq = 0;
/** Registers a token for `uid` and returns its string. */
function token(uid: string, overrides: Record<string, unknown> = {}): string {
  const value = `t${++seq}`;
  tokens.set(value, {
    uid,
    email: "a@example.com",
    email_verified: true,
    auth_time: now(),
    exp: now() + 3600,
    ...overrides,
  });
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  users.clear();
  tokens.clear();
  profileAccountId = "account-1";
  rpc.mockImplementation(() => ({ data: ROW, error: null }));
});

describe("verifySessionCookie", () => {
  it("accepts a valid cookie of an active user", async () => {
    users.set("u-valid", { disabled: false });
    expect(await verifySessionCookie(token("u-valid"))).toMatchObject({ uid: "u-valid" });
  });

  it("rejects a missing or forged cookie", async () => {
    expect(await verifySessionCookie(undefined)).toBeNull();
    expect(await verifySessionCookie("forged")).toBeNull();
  });

  it("rejects the cookie of a disabled or deleted user", async () => {
    users.set("u-disabled", { disabled: true });
    expect(await verifySessionCookie(token("u-disabled"))).toBeNull();
    expect(await verifySessionCookie(token("u-deleted"))).toBeNull();
  });

  it("rejects a cookie signed in before the user's sessions were revoked", async () => {
    users.set("u-revoked", {
      disabled: false,
      tokensValidAfterTime: new Date((now() + 60) * 1000).toUTCString(),
    });
    expect(await verifySessionCookie(token("u-revoked"))).toBeNull();
  });

  it("revokeAllSessions takes effect on this instance at once", async () => {
    users.set("u-signout", { disabled: false });
    const cookie = token("u-signout", { auth_time: now() - 10 });
    expect(await verifySessionCookie(cookie)).not.toBeNull();
    await revokeAllSessions("u-signout");
    expect(fakeAuth.revokeRefreshTokens).toHaveBeenCalledWith("u-signout");
    expect(await verifySessionCookie(cookie)).toBeNull();
  });
});

describe("getSessionUser", () => {
  it("maps the Firebase UID to the auth.users row", async () => {
    users.set("u-map", { disabled: false });
    expect(await getSessionUser(token("u-map"))).toMatchObject({ id: ROW.id, email: ROW.email });
    expect(rpc).toHaveBeenCalledWith("auth_user_by_firebase_uid", { p_firebase_uid: "u-map" });
  });
});

describe("createSession", () => {
  it("syncs auth.users, writes the account and user claims and mints the cookie", async () => {
    users.set("u-new", { disabled: false });
    const idToken = token("u-new", { name: "Ana" });

    const session = await createSession(idToken, undefined);

    expect(rpc).toHaveBeenCalledWith("auth_sync_user", {
      p_firebase_uid: "u-new",
      p_email: "a@example.com",
      p_email_verified: true,
      p_full_name: "Ana",
    });
    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith("u-new", {
      accountIds: ["account-1"],
      userId: ROW.id,
    });
    expect(session).toEqual({
      cookie: `cookie-for-${idToken}`,
      user: expect.objectContaining({ id: ROW.id }),
      claimsChanged: true,
    });
  });

  it("leaves unchanged claims alone", async () => {
    users.set("u-same", {
      disabled: false,
      customClaims: { accountIds: ["account-1"], userId: ROW.id, x: 1 },
    });
    const session = await createSession(token("u-same"), undefined);
    expect(fakeAuth.setCustomUserClaims).not.toHaveBeenCalled();
    expect(session.claimsChanged).toBe(false);
  });

  it("keeps other custom claims when the account changes", async () => {
    users.set("u-moved", { disabled: false, customClaims: { accountIds: ["old"], x: 1 } });
    profileAccountId = "account-2";
    await createSession(token("u-moved"), undefined);
    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith("u-moved", {
      accountIds: ["account-2"],
      userId: ROW.id,
      x: 1,
    });
  });

  it("adds the user claim to a token that only has the account claim", async () => {
    users.set("u-old", { disabled: false, customClaims: { accountIds: ["account-1"] } });
    const session = await createSession(token("u-old"), undefined);
    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith("u-old", {
      accountIds: ["account-1"],
      userId: ROW.id,
    });
    expect(session.claimsChanged).toBe(true);
  });

  it("refuses an invalid ID token", async () => {
    await expect(createSession("forged", undefined)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("refuses an unverified email, before touching the database", async () => {
    users.set("u-unverified", { disabled: false });
    await expect(
      createSession(token("u-unverified", { email_verified: false }), undefined),
    ).rejects.toMatchObject({ code: "email_not_verified" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses an old sign-in without a live session", async () => {
    users.set("u-old", { disabled: false });
    const stale = token("u-old", { auth_time: now() - 3600 });
    await expect(createSession(stale, undefined)).rejects.toBeInstanceOf(SessionError);
    await expect(createSession(stale, undefined)).rejects.toMatchObject({
      code: "recent_sign_in_required",
    });
  });

  it("renews an old sign-in when the browser still holds a session of the same user", async () => {
    users.set("u-renew", { disabled: false });
    const stale = token("u-renew", { auth_time: now() - 3600 });
    const cookie = token("u-renew", { auth_time: now() - 3600 });
    await expect(createSession(stale, cookie)).resolves.toMatchObject({ cookie: `cookie-for-${stale}` });
  });

  it("does not renew with another user's session", async () => {
    users.set("u-a", { disabled: false });
    users.set("u-b", { disabled: false });
    const stale = token("u-a", { auth_time: now() - 3600 });
    await expect(createSession(stale, token("u-b"))).rejects.toMatchObject({
      code: "recent_sign_in_required",
    });
  });

  it("answers email_in_use when another user holds the email", async () => {
    users.set("u-dup", { disabled: false });
    rpc.mockImplementation(() => ({ data: null, error: { code: "23505", message: "dup" } }));
    await expect(createSession(token("u-dup"), undefined)).rejects.toMatchObject({
      code: "email_in_use",
    });
  });
});
