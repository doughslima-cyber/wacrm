import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUCKETS,
  bucketConfig,
  cacheControlHeader,
  publicObjectUrl,
  storageBucketName,
  uploadRejection,
  type BucketName,
} from "./buckets";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("storage.rules", () => {
  const rules = readFileSync(join(process.cwd(), "storage.rules"), "utf8");
  const FUNCTIONS: Record<BucketName, string> = {
    avatars: "avatarFits",
    "flow-media": "flowMediaFits",
    "chat-media": "chatMediaFits",
  };

  for (const [bucket, fn] of Object.entries(FUNCTIONS) as Array<[BucketName, string]>) {
    it(`has the same limits as buckets.ts for ${bucket}`, () => {
      const match = rules.match(
        new RegExp(`function ${fn}\\(\\) \\{\\s*return fits\\((\\d+), \\[([^\\]]*)\\]\\);`),
      );
      expect(match, `${fn}() not found in storage.rules`).not.toBeNull();
      const [, maxBytes, list] = match!;
      const types = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);

      expect(Number(maxBytes)).toBe(BUCKETS[bucket].maxBytes);
      expect([...types].sort()).toEqual([...BUCKETS[bucket].mimeTypes].sort());
    });

    it(`has a match block for ${bucket}`, () => {
      expect(rules).toContain(`match /${bucket}/{`);
    });
  }
});

describe("uploadRejection", () => {
  it("accepts a file that fits", () => {
    expect(uploadRejection("chat-media", 1024, "audio/ogg")).toBeNull();
  });

  it("refuses an oversized file", () => {
    expect(uploadRejection("avatars", BUCKETS.avatars.maxBytes + 1, "image/png")).toMatch(/maximum/);
  });

  it("refuses a MIME type outside the bucket's list", () => {
    expect(uploadRejection("flow-media", 10, "audio/ogg")).toMatch(/not supported/);
    expect(uploadRejection("chat-media", 10, "")).toMatch(/not supported/);
  });

  it("refuses an unknown bucket", () => {
    expect(uploadRejection("secrets", 10, "text/plain")).toMatch(/not found/);
    expect(bucketConfig("toString")).toBeNull();
  });
});

describe("object URLs", () => {
  it("requires the bucket name instead of guessing it from the project", () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "demo-project");
    expect(() => storageBucketName()).toThrow(/NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET/);
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "demo-project.appspot.com");
    expect(storageBucketName()).toBe("demo-project.appspot.com");
  });

  it("builds a token-free public URL with the object name encoded", () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "b.example");
    expect(publicObjectUrl("chat-media", "account-1/inbound/1-a b.pdf")).toBe(
      "https://firebasestorage.googleapis.com/v0/b/b.example/o/chat-media%2Faccount-1%2Finbound%2F1-a%20b.pdf?alt=media",
    );
  });

  it("turns supabase-js cache seconds into a header", () => {
    expect(cacheControlHeader("3600")).toBe("public, max-age=3600");
    expect(cacheControlHeader(undefined)).toBe("public, max-age=3600");
    expect(cacheControlHeader("no-cache")).toBe("no-cache");
  });
});
