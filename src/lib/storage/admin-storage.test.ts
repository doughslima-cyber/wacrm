import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/firebase-admin", () => ({
  googleAccessToken: vi.fn(async () => "access-token"),
}));

import { adminStorage } from "./admin-storage";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "b.example");
  vi.stubEnv("GOOGLE_CLOUD_QUOTA_PROJECT", "");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("adminStorage.upload", () => {
  it("writes the object under its prefix with type and cache metadata", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    const { data, error } = await adminStorage
      .from("chat-media")
      .upload("account-1/inbound/1-a.ogg", Buffer.from("abc"), {
        contentType: "audio/ogg",
        cacheControl: "3600",
        upsert: true,
      });

    expect(error).toBeNull();
    expect(data).toEqual({ path: "account-1/inbound/1-a.ogg" });

    const [url, init] = fetchMock.mock.calls[0];
    const target = new URL(String(url));
    expect(target.pathname).toBe("/upload/storage/v1/b/b.example/o");
    expect(target.searchParams.get("uploadType")).toBe("multipart");
    expect(target.searchParams.has("ifGenerationMatch")).toBe(false);
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer access-token");

    const body = await (init!.body as Blob).text();
    expect(body).toContain(
      JSON.stringify({
        name: "chat-media/account-1/inbound/1-a.ogg",
        contentType: "audio/ogg",
        cacheControl: "public, max-age=3600",
      }),
    );
    expect(body).toContain("content-type: audio/ogg\r\n\r\nabc\r\n");
  });

  it("only creates when upsert is off", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 412 }));
    const { error } = await adminStorage
      .from("chat-media")
      .upload("account-1/a.png", new Uint8Array([1]), { contentType: "image/png" });

    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("ifGenerationMatch")).toBe("0");
    expect(error).toEqual({ message: "The resource already exists" });
  });

  it("enforces the bucket limits the rules can't, without calling the API", async () => {
    const tooBig = await adminStorage
      .from("chat-media")
      .upload("account-1/a.pdf", new Uint8Array(16 * 1024 * 1024 + 1), {
        contentType: "application/pdf",
      });
    const wrongType = await adminStorage
      .from("chat-media")
      .upload("account-1/a.exe", new Uint8Array(1), { contentType: "application/x-msdownload" });

    expect(tooBig.error?.message).toMatch(/maximum/);
    expect(wrongType.error?.message).toMatch(/not supported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the API's error instead of throwing", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "denied" } }), { status: 403 }),
    );
    const { error } = await adminStorage
      .from("avatars")
      .upload("u/a.png", new Uint8Array(1), { contentType: "image/png", upsert: true });
    expect(error).toEqual({ message: "denied" });

    fetchMock.mockRejectedValue(new Error("offline"));
    const again = await adminStorage
      .from("avatars")
      .upload("u/a.png", new Uint8Array(1), { contentType: "image/png", upsert: true });
    expect(again.error).toEqual({ message: "offline" });
  });
});

describe("adminStorage.remove", () => {
  it("deletes each object and treats a missing one as done", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const { data, error } = await adminStorage.from("flow-media").remove(["account-1/a.png", "account-1/b.png"]);

    expect(error).toBeNull();
    expect(data).toEqual([{ name: "account-1/a.png" }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://storage.googleapis.com/storage/v1/b/b.example/o/flow-media%2Faccount-1%2Fa.png",
    );
    expect(fetchMock.mock.calls[0][1]!.method).toBe("DELETE");
  });
});

describe("adminStorage.getPublicUrl", () => {
  it("is the token-free Firebase URL", () => {
    expect(adminStorage.from("avatars").getPublicUrl("u/a.png").data.publicUrl).toBe(
      "https://firebasestorage.googleapis.com/v0/b/b.example/o/avatars%2Fu%2Fa.png?alt=media",
    );
  });
});
