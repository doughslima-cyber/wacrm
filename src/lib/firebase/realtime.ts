// Browser-only: the realtime hub wired to Firestore and /api/rest.
//
// The browser client's channels (src/lib/supabase/client.ts) load this
// on first subscribe. Firestore is only a doorbell: the relay writes a
// signal per changed row to signals/{accountId}/changes
// (infra/relay-realtime), firestore.rules let a user read the accounts
// in their `accountIds` claim, and the row itself is read through
// /api/rest, where RLS applies. See src/lib/realtime/hub.ts.

import {
  collection,
  getFirestore,
  onSnapshot,
  query,
  Timestamp,
  where,
  type DocumentData,
  type Firestore,
} from "firebase/firestore";

import type { ChangeSignal } from "@/lib/realtime/changes";
import { RealtimeHub, type LogChange, type SignalHandlers } from "@/lib/realtime/hub";
import type { AppClient, RealtimeChannel, RealtimeStatusCallback } from "@/lib/supabase/app-client";
import { firebaseApp, firebaseAuth } from "./client";

let hub: RealtimeHub | undefined;
let firestore: Firestore | undefined;

export function join(
  client: AppClient,
  channel: RealtimeChannel,
  onStatus: RealtimeStatusCallback,
): () => void {
  hub ??= new RealtimeHub({
    async changesSince(after) {
      const { data, error } = await client.rpc("realtime_changes_since", { p_after: after });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return data as { now: string; changes: LogChange[] };
    },
    async fetchRows(table, column, ids) {
      const { data, error } = await client.from(table).select("*").in(column, ids);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return (data ?? []) as Record<string, unknown>[];
    },
    listen: listenForSignals,
    async refreshCredentials() {
      const auth = firebaseAuth();
      await auth.authStateReady();
      await auth.currentUser?.getIdToken(true);
    },
  });
  return hub.join(channel, onStatus);
}

class SignalsUnavailable extends Error {
  constructor(
    message: string,
    readonly code: "unauthenticated" | "permission-denied",
  ) {
    super(message);
  }
}

async function listenForSignals(startAt: string, handlers: SignalHandlers): Promise<() => void> {
  const auth = firebaseAuth();
  await auth.authStateReady();
  const user = auth.currentUser;
  // The session cookie can outlive the SDK's sign-in (cleared site
  // data, a cookie set by hand in dev). Polling covers that case.
  if (!user) throw new SignalsUnavailable("Not signed in to Firebase", "unauthenticated");

  const { claims } = await user.getIdTokenResult();
  const accountIds = Array.isArray(claims.accountIds)
    ? claims.accountIds.filter((id): id is string => typeof id === "string")
    : [];
  if (accountIds.length === 0) throw new SignalsUnavailable("No accountIds claim", "permission-denied");

  firestore ??= getFirestore(firebaseApp());
  const since = Timestamp.fromDate(new Date(startAt));
  const stops = accountIds.map((accountId) =>
    onSnapshot(
      query(collection(firestore!, "signals", accountId, "changes"), where("at", ">", since)),
      (snap) => {
        const added = snap
          .docChanges()
          .filter((change) => change.type === "added")
          .map((change) => toSignal(change.doc.data()))
          .filter((signal): signal is ChangeSignal => signal !== null)
          .sort((a, b) => Number(a.seq) - Number(b.seq));
        // A snapshot from the local cache says nothing about the server.
        if (!snap.metadata.fromCache) handlers.onLive();
        if (added.length > 0) handlers.onSignals(added);
      },
      (err) => handlers.onError(err),
    ),
  );
  return () => {
    for (const stop of stops) stop();
  };
}

function toSignal(data: DocumentData): ChangeSignal | null {
  if (typeof data.table !== "string" || typeof data.rowId !== "string") return null;
  const createdAt = data.createdAt instanceof Timestamp ? data.createdAt.toDate() : new Date();
  return {
    seq: String(data.seq),
    table: data.table,
    op: data.op,
    rowId: data.rowId,
    keys: (data.keys ?? {}) as Record<string, unknown>,
    ids: Array.isArray(data.ids) ? data.ids.map(String) : [String(data.seq)],
    createdAt: createdAt.toISOString(),
  };
}
