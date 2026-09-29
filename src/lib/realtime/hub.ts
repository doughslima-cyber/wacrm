// The browser's realtime hub: one per tab, shared by every channel.
//
// docs/firebase-migration.md §3.4, phase 4. Signals (which row of which
// table changed) come from two sources:
//
//   - Firestore, signals/{accountId}/changes, written by the relay
//     (infra/relay-realtime). The normal path: well under a second.
//   - Polling the change log itself (the realtime_changes_since RPC,
//     infra/db/migrations/045_realtime_notify.sql). A safety net when
//     Firestore is quiet for QUIET_MS (visible or not: hidden tabs
//     still raise desktop notifications), and the
//     only source when Firestore can't be used (no Firebase sign-in or
//     claim) or the relay is behind.
//
// Both sources carry change ids, so a change seen twice is delivered
// once. For each new signal the hub fetches the row through /api/rest
// (RLS decides; a row the user can't see is dropped), batching per
// table, and hands every matching listener a supabase-js payload, in
// change order.
//
// Status follows supabase-js: SUBSCRIBED once a source is live,
// CHANNEL_ERROR when none is, and SUBSCRIBED again on recovery — the
// transition the inbox uses to refetch what it may have missed.
//
// Nothing here imports Firebase: the sources are injected
// (src/lib/firebase/realtime.ts), which keeps this testable.

import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
  RealtimeStatus,
  RealtimeStatusCallback,
} from "@/lib/supabase/app-client";
import {
  parseFilter,
  primaryKeyOf,
  toPayload,
  wantsRow,
  wantsSignal,
  type ChangeListener,
  type ChangeOp,
  type ChangeSignal,
  type ParsedFilter,
} from "./changes";

type Row = Record<string, unknown>;

/** A row of the realtime_changes_since RPC. */
export interface LogChange {
  id: number | string;
  table: string;
  op: ChangeOp;
  row_id: string;
  keys: Record<string, unknown>;
  at: string;
}

export interface SignalHandlers {
  /** New signals, in change order. */
  onSignals(signals: ChangeSignal[]): void;
  /** The source is connected and up to date (a server snapshot). */
  onLive(): void;
  /** The source stopped; the hub falls back to polling. */
  onError(err: unknown): void;
}

export interface HubDeps {
  /** realtime_changes_since(p_after). */
  changesSince(after: string | null): Promise<{ now: string; changes: LogChange[] }>;
  /** Rows of `table` whose `column` is in `ids`, read as the user. */
  fetchRows(table: string, column: string, ids: string[]): Promise<Row[]>;
  /** Starts the push source for changes published after `startAt`.
   *  Resolves to its stop function; rejects when it can't start. */
  listen(startAt: string, handlers: SignalHandlers): Promise<() => void>;
  /** Refreshes the credentials `listen` uses (e.g. a stale claim). */
  refreshCredentials(): Promise<void>;
}

export const TICK_MS = 5_000;
/** Polling interval in a hidden tab (browsers throttle timers anyway). */
export const HIDDEN_POLL_MS = 30_000;
/** Push source silent this long → check the log, even in a hidden tab. */
export const QUIET_MS = 60_000;
/** A change this old that only polling found means the relay is behind. */
export const LAG_MS = 15_000;
/** Polls reread this much, for changes that committed late. */
export const LOOKBACK_MS = 5_000;
/** How far back realtime_changes_since looks at most. */
export const LOG_WINDOW_MS = 10 * 60_000;
export const RETRY_LISTEN_MS = 60_000;
export const RETRY_START_MS = 10_000;
/** Keep change ids this long for dedupe (longer than LOG_WINDOW_MS). */
export const SEEN_TTL_MS = 15 * 60_000;
/** Last channel gone → stop after this, unless another one joins. */
export const IDLE_STOP_MS = 10_000;
export const FETCH_CHUNK = 100;

type Mode = "idle" | "starting" | "push" | "polling";

const NEVER_MATCHES: ParsedFilter = { column: "", test: () => false };

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

export function signalFromLog(change: LogChange): ChangeSignal {
  const id = String(change.id);
  return {
    seq: id,
    table: change.table,
    op: change.op,
    rowId: change.row_id,
    keys: change.keys,
    ids: [id],
    createdAt: change.at,
  };
}

export class RealtimeHub {
  private readonly members = new Map<RealtimeChannel, RealtimeStatusCallback>();
  private readonly parsed = new WeakMap<object, ParsedFilter | null>();
  private readonly seen = new Map<string, number>();
  private queue: ChangeSignal[] = [];

  private mode: Mode = "idle";
  private status: RealtimeStatus | null = null;
  /** Bumped on stop: async work from an older run checks it and quits. */
  private generation = 0;

  private startAt: string | null = null;
  private cursor: string | null = null;
  private stopListen: (() => void) | null = null;
  private listening = false;
  private nextListenAt = 0;
  private refreshedCredentials = false;
  private lastPushAt = 0;
  private lastPollAt = 0;
  private polling = false;
  private processing = false;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onVisibility = () => {
    if (isVisible()) this.tick();
  };

  constructor(private readonly deps: HubDeps) {}

  join(channel: RealtimeChannel, onStatus: RealtimeStatusCallback): () => void {
    this.members.set(channel, onStatus);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.mode === "idle") {
      void this.start();
    } else if (this.status) {
      const status = this.status;
      queueMicrotask(() => {
        if (this.members.get(channel) === onStatus) onStatus(status);
      });
    }
    return () => {
      if (this.members.get(channel) !== onStatus) return;
      this.members.delete(channel);
      if (this.members.size === 0 && !this.idleTimer) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.members.size === 0) this.stop();
        }, IDLE_STOP_MS);
      }
    };
  }

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  private async start(): Promise<void> {
    const gen = this.generation;
    this.mode = "starting";
    let now: string;
    try {
      ({ now } = await this.deps.changesSince(null));
    } catch (err) {
      if (gen !== this.generation) return;
      this.setStatus("CHANNEL_ERROR", err);
      setTimeout(() => {
        if (gen === this.generation && this.mode === "starting" && this.members.size > 0) {
          void this.start();
        }
      }, RETRY_START_MS);
      return;
    }
    if (gen !== this.generation) return;

    this.startAt = now;
    this.cursor = now;
    this.lastPollAt = Date.now();
    this.mode = "polling";
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    await this.tryListen();
  }

  private stop(): void {
    this.generation++;
    this.stopListen?.();
    this.stopListen = null;
    this.listening = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.mode = "idle";
    this.status = null;
    this.startAt = null;
    this.cursor = null;
    this.queue = [];
    this.seen.clear();
    this.refreshedCredentials = false;
    this.nextListenAt = 0;
  }

  private tick(): void {
    if (this.mode === "idle" || this.mode === "starting") return;
    const now = Date.now();
    if (!this.listening && now >= this.nextListenAt) void this.tryListen();

    if (this.mode === "polling") {
      const interval = isVisible() ? TICK_MS : HIDDEN_POLL_MS;
      if (now - this.lastPollAt >= interval - 50) void this.poll();
    } else if (now - Math.max(this.lastPushAt, this.lastPollAt) >= QUIET_MS) {
      void this.poll();
    }
    this.pruneSeen(now);
  }

  // ----------------------------------------------------------------
  // Push source
  // ----------------------------------------------------------------

  private async tryListen(): Promise<void> {
    if (this.listening || !this.startAt) return;
    const gen = this.generation;
    this.listening = true;
    this.nextListenAt = Number.POSITIVE_INFINITY;
    try {
      const stop = await this.deps.listen(this.startAt, {
        onSignals: (signals) => {
          if (gen === this.generation) this.receive(signals);
        },
        onLive: () => {
          if (gen !== this.generation) return;
          this.lastPushAt = Date.now();
          this.refreshedCredentials = false;
          if (this.mode !== "push") {
            this.mode = "push";
            this.setStatus("SUBSCRIBED");
          }
        },
        onError: (err) => {
          if (gen === this.generation) void this.listenFailed(err);
        },
      });
      if (gen !== this.generation) {
        stop();
        return;
      }
      this.stopListen = stop;
    } catch (err) {
      if (gen === this.generation) await this.listenFailed(err);
    }
  }

  private async listenFailed(err: unknown): Promise<void> {
    const gen = this.generation;
    this.stopListen?.();
    this.stopListen = null;
    this.listening = false;

    // A claim that changed after the ID token was issued: refresh it
    // once and retry right away.
    if (errorCode(err) === "permission-denied" && !this.refreshedCredentials) {
      this.refreshedCredentials = true;
      try {
        await this.deps.refreshCredentials();
      } catch {
        // Retried on the normal schedule below.
      }
      if (gen !== this.generation) return;
      this.nextListenAt = 0;
      void this.tryListen();
      return;
    }

    console.warn("[realtime] push source unavailable, polling:", (err as Error)?.message ?? err);
    this.nextListenAt = Date.now() + RETRY_LISTEN_MS;
    if (this.mode === "push") this.mode = "polling";
    void this.poll();
  }

  // ----------------------------------------------------------------
  // Polling
  // ----------------------------------------------------------------

  private async poll(): Promise<void> {
    if (this.polling || !this.cursor || !this.startAt) return;
    const gen = this.generation;
    const after = this.cursor;
    this.polling = true;
    this.lastPollAt = Date.now();
    try {
      const { now, changes } = await this.deps.changesSince(after);
      if (gen !== this.generation) return;
      const serverNow = Date.parse(now);
      const signals = changes.map(signalFromLog);

      if (this.mode === "push") {
        const behind = signals.some(
          (s) => s.ids.some((id) => !this.seen.has(id)) && serverNow - Date.parse(s.createdAt) > LAG_MS,
        );
        if (behind) {
          console.warn("[realtime] relay is behind, polling until it catches up");
          this.mode = "polling";
        }
      } else if (serverNow - Date.parse(after) > LOG_WINDOW_MS) {
        // Polls stopped for longer than the log keeps (a sleeping
        // laptop, a throttled tab): some changes may be gone.
        this.resync();
      }

      this.receive(signals);
      this.advanceCursor(changes, serverNow);
      if (this.mode === "polling") this.setStatus("SUBSCRIBED");
    } catch (err) {
      if (gen !== this.generation) return;
      if (this.mode === "polling") this.setStatus("CHANNEL_ERROR", err);
    } finally {
      if (gen === this.generation) this.polling = false;
    }
  }

  private advanceCursor(changes: LogChange[], serverNow: number): void {
    const startAt = Date.parse(this.startAt!);
    let next: number;
    if (changes.length >= 500) {
      // A full page: continue right after it.
      next = Date.parse(changes[changes.length - 1].at);
    } else {
      next = Math.max(Date.parse(this.cursor!), serverNow - LOOKBACK_MS);
    }
    this.cursor = new Date(Math.max(next, startAt)).toISOString();
  }

  // ----------------------------------------------------------------
  // Delivery
  // ----------------------------------------------------------------

  private receive(signals: ChangeSignal[]): void {
    const now = Date.now();
    for (const signal of signals) {
      const fresh = signal.ids.filter((id) => !this.seen.has(id));
      if (fresh.length === 0) continue;
      for (const id of signal.ids) this.seen.set(id, now);
      this.queue.push(signal);
    }
    void this.process();
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue;
        this.queue = [];
        await this.deliver(batch);
      }
    } finally {
      this.processing = false;
    }
  }

  private listenersOf(
    channel: RealtimeChannel,
  ): Array<ChangeListener & { callback: (payload: RealtimePostgresChangesPayload) => void }> {
    return channel.listeners.map((entry) => {
      let parsed = this.parsed.get(entry);
      if (parsed === undefined) {
        try {
          parsed = parseFilter(entry.filter.filter);
        } catch (err) {
          console.error("[realtime]", (err as Error).message);
          parsed = NEVER_MATCHES;
        }
        this.parsed.set(entry, parsed);
      }
      return { filter: entry.filter, parsed, callback: entry.callback };
    });
  }

  private async deliver(batch: ChangeSignal[]): Promise<void> {
    const gen = this.generation;
    const channels = [...this.members.keys()];
    const listeners = channels.flatMap((c) => this.listenersOf(c));
    const relevant = batch.filter((s) => listeners.some((l) => wantsSignal(l, s) !== false));
    if (relevant.length === 0) return;

    const rows = new Map<string, Row>();
    const rowKey = (table: string, id: string) => `${table}\u0000${id}`;
    const wanted = new Map<string, Set<string>>();
    for (const s of relevant) {
      if (s.op === "DELETE") continue;
      if (!wanted.has(s.table)) wanted.set(s.table, new Set());
      wanted.get(s.table)!.add(s.rowId);
    }

    let fetchFailed = false;
    await Promise.all(
      [...wanted].map(async ([table, idSet]) => {
        const column = primaryKeyOf(table);
        const ids = [...idSet];
        for (let i = 0; i < ids.length; i += FETCH_CHUNK) {
          try {
            const data = await this.deps.fetchRows(table, column, ids.slice(i, i + FETCH_CHUNK));
            for (const row of data) rows.set(rowKey(table, String(row[column])), row);
          } catch (err) {
            fetchFailed = true;
            console.error(`[realtime] fetching ${table} failed:`, (err as Error)?.message ?? err);
          }
        }
      }),
    );
    if (gen !== this.generation) return;

    for (const signal of relevant) {
      const row = signal.op === "DELETE" ? null : (rows.get(rowKey(signal.table, signal.rowId)) ?? null);
      // Not visible to this user (RLS), or already gone.
      if (signal.op !== "DELETE" && !row) continue;
      for (const channel of this.members.keys()) {
        for (const listener of this.listenersOf(channel)) {
          const match = row ? wantsRow(listener, signal, row) : wantsSignal(listener, signal) === true;
          if (!match) continue;
          try {
            listener.callback(toPayload(signal, row));
          } catch (err) {
            console.error("[realtime] listener failed:", err);
          }
        }
      }
    }

    // Changes were lost for the affected listeners: tell the channels,
    // the way a dropped socket would, so pages that resync on
    // reconnect do.
    if (fetchFailed) this.resync();
  }

  // ----------------------------------------------------------------
  // Status
  // ----------------------------------------------------------------

  private setStatus(status: RealtimeStatus, err?: unknown): void {
    if (this.status === status) return;
    this.status = status;
    const error = err instanceof Error ? err : err ? new Error(String((err as Error)?.message ?? err)) : undefined;
    for (const onStatus of [...this.members.values()]) onStatus(status, error);
  }

  /** CHANNEL_ERROR → SUBSCRIBED, for listeners that refetch on reconnect. */
  private resync(): void {
    if (this.status !== "SUBSCRIBED") return;
    this.setStatus("CHANNEL_ERROR");
    this.setStatus("SUBSCRIBED");
  }

  private pruneSeen(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at > SEEN_TTL_MS) this.seen.delete(id);
    }
  }
}
