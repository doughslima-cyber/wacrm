import { describe, expect, it } from "vitest";

import {
  parseFilter,
  primaryKeyOf,
  toPayload,
  wantsRow,
  wantsSignal,
  type ChangeListener,
  type ChangeSignal,
} from "./changes";

const signal = (over: Partial<ChangeSignal> = {}): ChangeSignal => ({
  seq: "1",
  table: "message_reactions",
  op: "INSERT",
  rowId: "r1",
  keys: { id: "r1", conversation_id: "c1", message_id: "m1" },
  ids: ["1"],
  createdAt: "2026-09-28T12:00:00.000Z",
  ...over,
});

const listener = (
  filter: Partial<ChangeListener["filter"]> = {},
): ChangeListener => {
  const f = { event: "*" as const, schema: "public", table: "message_reactions", ...filter };
  return { filter: f, parsed: parseFilter(f.filter) };
};

describe("parseFilter", () => {
  it("accepts eq, neq and in", () => {
    expect(parseFilter("conversation_id=eq.c1")!.test("c1")).toBe(true);
    expect(parseFilter("conversation_id=eq.c1")!.test("c2")).toBe(false);
    expect(parseFilter("status=neq.closed")!.test("open")).toBe(true);
    const inList = parseFilter("id=in.(a, b,\"c\")")!;
    expect(["a", "b", "c", "d"].map(inList.test)).toEqual([true, true, true, false]);
  });

  it("compares numbers by their text form", () => {
    expect(parseFilter("unread_count=eq.3")!.test(3)).toBe(true);
  });

  it("returns null without a filter and throws on anything else", () => {
    expect(parseFilter(undefined)).toBeNull();
    expect(() => parseFilter("created_at=gt.2026-01-01")).toThrow(/Unsupported/);
    expect(() => parseFilter("nonsense")).toThrow(/Unsupported/);
  });
});

describe("wantsSignal / wantsRow", () => {
  it("matches table, schema and event", () => {
    expect(wantsSignal(listener(), signal())).toBe(true);
    expect(wantsSignal(listener({ table: "messages" }), signal())).toBe(false);
    expect(wantsSignal(listener({ schema: "other" }), signal())).toBe(false);
    expect(wantsSignal(listener({ event: "DELETE" }), signal())).toBe(false);
    expect(wantsSignal(listener({ event: "INSERT" }), signal())).toBe(true);
  });

  it("decides filters on key columns before any fetch", () => {
    const own = listener({ filter: "conversation_id=eq.c1" });
    const other = listener({ filter: "conversation_id=eq.c2" });
    expect(wantsSignal(own, signal())).toBe(true);
    expect(wantsSignal(other, signal())).toBe(false);
    expect(wantsSignal(other, signal({ op: "DELETE" }))).toBe(false);
  });

  it("defers filters on other columns to the row, and never matches them on DELETE", () => {
    const byEmoji = listener({ filter: "emoji=eq.👍" });
    expect(wantsSignal(byEmoji, signal())).toBe("row");
    expect(wantsRow(byEmoji, signal(), { emoji: "👍" })).toBe(true);
    expect(wantsRow(byEmoji, signal(), { emoji: "❤️" })).toBe(false);
    expect(wantsSignal(byEmoji, signal({ op: "DELETE" }))).toBe(false);
  });
});

describe("toPayload", () => {
  it("INSERT carries the row and an empty old", () => {
    const row = { id: "r1", emoji: "👍" };
    expect(toPayload(signal(), row)).toEqual({
      eventType: "INSERT",
      schema: "public",
      table: "message_reactions",
      commit_timestamp: "2026-09-28T12:00:00.000Z",
      new: row,
      old: {},
      errors: null,
    });
  });

  it("UPDATE carries the row and the keys as old", () => {
    const payload = toPayload(signal({ op: "UPDATE" }), { id: "r1" });
    expect(payload.new).toEqual({ id: "r1" });
    expect(payload.old).toEqual({ id: "r1", conversation_id: "c1", message_id: "m1" });
  });

  it("DELETE carries only the keys", () => {
    const payload = toPayload(signal({ op: "DELETE" }), null);
    expect(payload.new).toEqual({});
    expect(payload.old).toEqual({ id: "r1", conversation_id: "c1", message_id: "m1" });
  });
});

describe("primaryKeyOf", () => {
  it("knows member_presence is keyed by user_id", () => {
    expect(primaryKeyOf("member_presence")).toBe("user_id");
    expect(primaryKeyOf("messages")).toBe("id");
  });
});
