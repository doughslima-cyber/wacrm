// Turning realtime signals into supabase-js `postgres_changes` payloads.
//
// A signal says which row changed (docs/firebase-migration.md §3.4):
// table, op, primary key and the few key columns listeners filter on
// (infra/db/migrations/045_realtime_notify.sql). The browser fetches
// INSERT/UPDATE rows itself, through RLS, and hands the listeners the
// same payload shape Supabase Realtime did.
//
// Isomorphic and dependency-free, so it can be unit tested.

import type {
  PostgresChangesFilter,
  RealtimePostgresChangesPayload,
} from "@/lib/supabase/app-client";

export type ChangeOp = "INSERT" | "UPDATE" | "DELETE";

export interface ChangeSignal {
  /** Id of the last app_realtime.changes row this signal stands for. */
  seq: string;
  table: string;
  op: ChangeOp;
  /** Primary key value of the changed row. */
  rowId: string;
  /** Primary key and filterable key columns, from the trigger. */
  keys: Record<string, unknown>;
  /** Every change id folded into this signal (for dedupe). */
  ids: string[];
  /** When the change was logged (ISO). */
  createdAt: string;
}

type Row = Record<string, unknown>;

/** Primary key column per table; `id` unless listed. */
const PRIMARY_KEYS: Record<string, string> = {
  member_presence: "user_id",
};

export function primaryKeyOf(table: string): string {
  return PRIMARY_KEYS[table] ?? "id";
}

// ------------------------------------------------------------------
// Filters: the PostgREST-style `column=op.value` strings supabase-js
// accepts on postgres_changes. Supabase Realtime supports eq, neq, lt,
// lte, gt, gte and in; the app uses eq. Comparisons are on the text
// form, like the values in the filter string itself.
// ------------------------------------------------------------------

export interface ParsedFilter {
  column: string;
  test: (value: unknown) => boolean;
}

const asText = (value: unknown) => (value === null || value === undefined ? null : String(value));

export function parseFilter(filter: string | undefined): ParsedFilter | null {
  if (!filter) return null;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(eq|neq|in)\.(.*)$/.exec(filter);
  if (!match) throw new Error(`Unsupported realtime filter: ${filter}`);
  const [, column, op, raw] = match;
  if (op === "in") {
    const list = /^\((.*)\)$/.exec(raw);
    if (!list) throw new Error(`Unsupported realtime filter: ${filter}`);
    const values = new Set(list[1].split(",").map((v) => v.trim().replace(/^"(.*)"$/, "$1")));
    return { column, test: (v) => values.has(asText(v) ?? "") };
  }
  return op === "eq"
    ? { column, test: (v) => asText(v) === raw }
    : { column, test: (v) => asText(v) !== raw };
}

export interface ChangeListener {
  filter: PostgresChangesFilter;
  parsed: ParsedFilter | null;
}

function tableAndEventMatch(listener: ChangeListener, signal: ChangeSignal): boolean {
  const { filter } = listener;
  if (filter.schema !== "public" && filter.schema !== "*") return false;
  if (filter.table !== signal.table && filter.table !== "*") return false;
  return filter.event === "*" || filter.event === signal.op;
}

/**
 * Before any fetch: `false` when this listener can't want the signal,
 * `true` when it does, `"row"` when the answer depends on a column
 * only the row has.
 */
export function wantsSignal(listener: ChangeListener, signal: ChangeSignal): boolean | "row" {
  if (!tableAndEventMatch(listener, signal)) return false;
  const { parsed } = listener;
  if (!parsed) return true;
  if (parsed.column in signal.keys) return parsed.test(signal.keys[parsed.column]);
  // A DELETE carries only the keys: like Supabase, a filter on any
  // other column can't match it.
  return signal.op === "DELETE" ? false : "row";
}

/** After the fetch: whether the listener gets this row. */
export function wantsRow(listener: ChangeListener, signal: ChangeSignal, row: Row): boolean {
  const wanted = wantsSignal(listener, signal);
  if (wanted !== "row") return wanted;
  return listener.parsed!.test(row[listener.parsed!.column]);
}

/** The supabase-js payload. INSERT/UPDATE need the fetched row. */
export function toPayload(signal: ChangeSignal, row: Row | null): RealtimePostgresChangesPayload {
  const keys = { ...signal.keys };
  return {
    eventType: signal.op,
    schema: "public",
    table: signal.table,
    commit_timestamp: signal.createdAt,
    new: signal.op === "DELETE" ? {} : { ...row },
    old: signal.op === "INSERT" ? {} : keys,
    errors: null,
  };
}
