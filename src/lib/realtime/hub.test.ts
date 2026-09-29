import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RealtimeChannel,
  type RealtimePostgresChangesPayload,
  type RealtimeStatus,
} from "@/lib/supabase/app-client";
import type { ChangeSignal } from "./changes";
import {
  FETCH_RETRIES,
  FETCH_RETRY_MS,
  IDLE_STOP_MS,
  QUIET_MS,
  RETRY_LISTEN_MS,
  RealtimeHub,
  TICK_MS,
  type HubDeps,
  type LogChange,
  type SignalHandlers,
} from "./hub";

const T0 = Date.parse("2026-09-28T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function signal(over: Partial<ChangeSignal> & { seq: string }): ChangeSignal {
  return {
    table: "messages",
    op: "INSERT",
    rowId: `m${over.seq}`,
    keys: { id: `m${over.seq}`, conversation_id: "c1" },
    ids: [over.seq],
    createdAt: iso(Date.now()),
    ...over,
  };
}

function logChange(id: number, over: Partial<LogChange> = {}): LogChange {
  return {
    id,
    table: "messages",
    op: "INSERT",
    row_id: `m${id}`,
    keys: { id: `m${id}`, conversation_id: "c1" },
    at: iso(Date.now()),
    ...over,
  };
}

/** Fake sources; tests drive `push` and fill `log` / `rows`. */
function setup(opts: { listen?: "ok" | Error } = {}) {
  const log: LogChange[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let push: SignalHandlers | null = null;
  const stopListen = vi.fn();

  const deps = {
    changesSince: vi.fn(async (after: string | null) => ({
      now: iso(Date.now()),
      changes: after ? log.filter((c) => c.at > after) : [],
    })),
    fetchRows: vi.fn(async (table: string, column: string, ids: string[]) =>
      ids.map((id) => rows.get(`${table}:${id}`)).filter((r): r is Record<string, unknown> => !!r),
    ),
    listen: vi.fn(async (_startAt: string, handlers: SignalHandlers) => {
      if (opts.listen instanceof Error) throw opts.listen;
      push = handlers;
      return stopListen;
    }),
    refreshCredentials: vi.fn(async () => {}),
  } satisfies HubDeps;

  const hub = new RealtimeHub(deps);
  return {
    hub,
    deps,
    log,
    rows,
    stopListen,
    push: () => {
      if (!push) throw new Error("not listening");
      return push;
    },
  };
}

function subscribe(
  hub: RealtimeHub,
  filter: { table: string; event?: "*" | "INSERT" | "UPDATE" | "DELETE"; filter?: string },
) {
  const events: RealtimePostgresChangesPayload[] = [];
  const statuses: RealtimeStatus[] = [];
  const channel = new RealtimeChannel("test").on(
    "postgres_changes",
    { event: filter.event ?? "*", schema: "public", table: filter.table, filter: filter.filter },
    (payload) => events.push(payload),
  );
  const leave = hub.join(channel, (status) => statuses.push(status));
  return { events, statuses, leave };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("RealtimeHub — push source", () => {
  it("fetches the row and delivers an INSERT once the source is live", async () => {
    const { hub, deps, rows, push } = setup();
    const sub = subscribe(hub, { table: "messages" });
    await flush();
    expect(deps.listen).toHaveBeenCalledWith(iso(T0), expect.anything());

    push().onLive();
    expect(sub.statuses).toEqual(["SUBSCRIBED"]);

    rows.set("messages:m1", { id: "m1", content_text: "oi" });
    push().onSignals([signal({ seq: "1" })]);
    await flush();

    expect(deps.fetchRows).toHaveBeenCalledWith("messages", "id", ["m1"]);
    expect(sub.events).toHaveLength(1);
    expect(sub.events[0]).toMatchObject({ eventType: "INSERT", new: { id: "m1", content_text: "oi" }, old: {} });
  });

  it("drops rows RLS doesn't return", async () => {
    const { hub, push } = setup();
    const sub = subscribe(hub, { table: "notifications" });
    await flush();
    push().onLive();
    push().onSignals([signal({ seq: "1", table: "notifications", rowId: "n1", keys: { id: "n1" } })]);
    await flush();
    expect(sub.events).toEqual([]);
  });

  it("batches fetches per table and keeps change order across tables", async () => {
    const { hub, deps, rows, push } = setup();
    const order: string[] = [];
    const channel = new RealtimeChannel("inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (p) => order.push(`msg:${p.new.id}`))
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, (p) =>
        order.push(`conv:${p.new.id}`),
      );
    hub.join(channel, () => {});
    await flush();
    push().onLive();

    rows.set("messages:m1", { id: "m1" });
    rows.set("messages:m3", { id: "m3" });
    rows.set("conversations:c1", { id: "c1" });
    push().onSignals([
      signal({ seq: "1" }),
      signal({ seq: "2", table: "conversations", op: "UPDATE", rowId: "c1", keys: { id: "c1" } }),
      signal({ seq: "3" }),
    ]);
    await flush();

    expect(deps.fetchRows).toHaveBeenCalledTimes(2);
    expect(deps.fetchRows).toHaveBeenCalledWith("messages", "id", ["m1", "m3"]);
    expect(order).toEqual(["msg:m1", "conv:c1", "msg:m3"]);
  });

  it("delivers DELETE from the keys, without a fetch, honouring key filters", async () => {
    const { hub, deps, push } = setup();
    const mine = subscribe(hub, { table: "message_reactions", event: "DELETE", filter: "conversation_id=eq.c1" });
    const other = subscribe(hub, { table: "message_reactions", event: "DELETE", filter: "conversation_id=eq.c2" });
    await flush();
    push().onLive();
    push().onSignals([
      signal({ seq: "1", table: "message_reactions", op: "DELETE", rowId: "r1", keys: { id: "r1", conversation_id: "c1" } }),
    ]);
    await flush();

    expect(deps.fetchRows).not.toHaveBeenCalled();
    expect(mine.events).toHaveLength(1);
    expect(mine.events[0]).toMatchObject({ eventType: "DELETE", new: {}, old: { id: "r1", conversation_id: "c1" } });
    expect(other.events).toEqual([]);
  });

  it("skips the fetch when no listener's key filter matches", async () => {
    const { hub, deps, push } = setup();
    subscribe(hub, { table: "message_reactions", filter: "conversation_id=eq.c2" });
    await flush();
    push().onLive();
    push().onSignals([signal({ seq: "1", table: "message_reactions", keys: { id: "r1", conversation_id: "c1" } })]);
    await flush();
    expect(deps.fetchRows).not.toHaveBeenCalled();
  });

  it("delivers a change once when both push and polling see it", async () => {
    const { hub, rows, log, push } = setup();
    const sub = subscribe(hub, { table: "messages" });
    await flush();
    push().onLive();
    rows.set("messages:m1", { id: "m1" });

    vi.setSystemTime(T0 + 1000);
    log.push(logChange(1));
    push().onSignals([signal({ seq: "1" })]);
    await flush();

    // Quiet push → the watchdog polls and finds the same change.
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(sub.events).toHaveLength(1);
  });

  it("switches to polling when the relay is behind", async () => {
    const { hub, deps, rows, log, push } = setup();
    const sub = subscribe(hub, { table: "messages" });
    await flush();
    push().onLive();
    rows.set("messages:m1", { id: "m1" });
    rows.set("messages:m2", { id: "m2" });

    vi.setSystemTime(T0 + 1000);
    log.push(logChange(1)); // never pushed
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(sub.events.map((e) => e.new.id)).toEqual(["m1"]);

    // Now polling every tick instead of every QUIET_MS.
    const polls = deps.changesSince.mock.calls.length;
    log.push(logChange(2, { at: iso(Date.now()) }));
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(deps.changesSince.mock.calls.length).toBe(polls + 1);
    expect(sub.events.map((e) => e.new.id)).toEqual(["m1", "m2"]);
    expect(sub.statuses).toEqual(["SUBSCRIBED"]);

    // The relay catches up: back to push.
    push().onLive();
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(deps.changesSince.mock.calls.length).toBe(polls + 1);
  });

  it("still checks the log from a hidden tab (desktop notifications live there)", async () => {
    vi.stubGlobal("document", {
      visibilityState: "hidden",
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    try {
      const { hub, rows, log, push } = setup();
      const sub = subscribe(hub, { table: "messages", event: "INSERT" });
      await flush();
      push().onLive();
      rows.set("messages:m1", { id: "m1" });
      vi.setSystemTime(T0 + 1000);
      log.push(logChange(1)); // the relay is down: never pushed
      await vi.advanceTimersByTimeAsync(QUIET_MS);
      expect(sub.events.map((e) => e.new.id)).toEqual(["m1"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries a failed row fetch and delivers the change", async () => {
    const { hub, deps, rows, push } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = subscribe(hub, { table: "messages" });
    await flush();
    push().onLive();
    rows.set("messages:m1", { id: "m1" });
    deps.fetchRows.mockRejectedValueOnce(new Error("network"));
    push().onSignals([signal({ seq: "1" })]);
    await flush();
    expect(sub.events).toEqual([]);

    await vi.advanceTimersByTimeAsync(FETCH_RETRY_MS);
    expect(sub.events.map((e) => e.new.id)).toEqual(["m1"]);
    expect(sub.statuses).toEqual(["SUBSCRIBED"]);
  });

  it("after the last retry, resyncs and lets polling deliver the change", async () => {
    const { hub, deps, rows, log, push } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = subscribe(hub, { table: "messages" });
    await flush();
    push().onLive();
    rows.set("messages:m1", { id: "m1" });
    vi.setSystemTime(T0 + 1000);
    log.push(logChange(1));

    deps.fetchRows.mockRejectedValue(new Error("network"));
    push().onSignals([signal({ seq: "1" })]);
    await vi.advanceTimersByTimeAsync(FETCH_RETRY_MS * (2 ** FETCH_RETRIES - 1));
    expect(deps.fetchRows).toHaveBeenCalledTimes(1 + FETCH_RETRIES);
    expect(sub.events).toEqual([]);
    expect(sub.statuses).toEqual(["SUBSCRIBED", "CHANNEL_ERROR", "SUBSCRIBED"]);

    // The change id was released: the next check of the log delivers it.
    deps.fetchRows.mockReset();
    deps.fetchRows.mockImplementation(async (table, _column, ids) =>
      ids.map((id) => rows.get(`${table}:${id}`)).filter((r): r is Record<string, unknown> => !!r),
    );
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(sub.events.map((e) => e.new.id)).toEqual(["m1"]);
  });
});

describe("RealtimeHub — without push", () => {
  it("polls every tick and reports SUBSCRIBED when Firebase isn't signed in", async () => {
    const unauthenticated = Object.assign(new Error("Not signed in"), { code: "unauthenticated" });
    const { hub, deps, rows, log } = setup({ listen: unauthenticated });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sub = subscribe(hub, { table: "messages" });
    await flush();
    expect(deps.refreshCredentials).not.toHaveBeenCalled();
    expect(sub.statuses).toEqual(["SUBSCRIBED"]);

    rows.set("messages:m1", { id: "m1" });
    vi.setSystemTime(T0 + 1000);
    log.push(logChange(1));
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(sub.events.map((e) => e.new.id)).toEqual(["m1"]);

    // Push is retried later.
    expect(deps.listen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_LISTEN_MS);
    expect(deps.listen).toHaveBeenCalledTimes(2);
  });

  it("refreshes the ID token once on permission-denied, then retries", async () => {
    const denied = Object.assign(new Error("denied"), { code: "permission-denied" });
    const { hub, deps } = setup({ listen: denied });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    subscribe(hub, { table: "messages" });
    await flush();
    expect(deps.refreshCredentials).toHaveBeenCalledTimes(1);
    expect(deps.listen).toHaveBeenCalledTimes(2);
  });

  it("reports CHANNEL_ERROR while polling fails and SUBSCRIBED on recovery", async () => {
    const { hub, deps } = setup({ listen: Object.assign(new Error("x"), { code: "unauthenticated" }) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sub = subscribe(hub, { table: "messages" });
    await flush();

    deps.changesSince.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(sub.statuses).toEqual(["SUBSCRIBED", "CHANNEL_ERROR", "SUBSCRIBED"]);
  });
});

describe("RealtimeHub — lifecycle", () => {
  it("shares one source across channels and stops after the last one leaves", async () => {
    const { hub, deps, stopListen, push } = setup();
    const a = subscribe(hub, { table: "messages" });
    const b = subscribe(hub, { table: "notifications" });
    await flush();
    expect(deps.listen).toHaveBeenCalledTimes(1);
    push().onLive();
    expect(b.statuses).toEqual(["SUBSCRIBED"]);

    // A late joiner is told the current status.
    const c = subscribe(hub, { table: "conversations" });
    await flush();
    expect(c.statuses).toEqual(["SUBSCRIBED"]);

    a.leave();
    b.leave();
    c.leave();
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1);
    expect(stopListen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stopListen).toHaveBeenCalledTimes(1);

    // A new channel starts it again.
    subscribe(hub, { table: "messages" });
    await flush();
    expect(deps.listen).toHaveBeenCalledTimes(2);
  });

  it("keeps running when a channel rejoins within the grace period", async () => {
    const { hub, stopListen } = setup();
    const a = subscribe(hub, { table: "messages" });
    await flush();
    a.leave();
    subscribe(hub, { table: "messages" });
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS * 2);
    expect(stopListen).not.toHaveBeenCalled();
  });

  it("an unsupported filter matches nothing instead of throwing", async () => {
    const { hub, rows, push } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = subscribe(hub, { table: "messages", filter: "created_at=gt.2026-01-01" });
    await flush();
    push().onLive();
    rows.set("messages:m1", { id: "m1" });
    push().onSignals([signal({ seq: "1" })]);
    await flush();
    expect(sub.events).toEqual([]);
  });
});
