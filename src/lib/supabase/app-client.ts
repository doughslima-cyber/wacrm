// The client every `createClient()` / `supabaseAdmin()` returns.
//
// The app used to talk to Supabase through supabase-js. After the move
// to Cloud SQL + PostgREST (docs/firebase-migration.md) the database
// half is still the same query builder — supabase-js *is* postgrest-js
// for `.from()` / `.rpc()` — so AppClient extends PostgrestClient and
// the ~420 query call sites keep working untouched. The non-database
// parts supabase-js used to carry (`auth`, `storage`, `channel`) are
// plugged in per environment: browser, server, or service role.
//
// Isomorphic: nothing here may import server-only modules.

import { PostgrestClient, type PostgrestError } from "@supabase/postgrest-js";

export type { PostgrestError };

type Fetch = typeof fetch;

// ------------------------------------------------------------------
// Auth
// ------------------------------------------------------------------

/** The subset of Supabase's `User` the app reads. `id` is the uuid in
 *  auth.users that every RLS policy and FK uses — not the Firebase UID. */
export interface User {
  id: string;
  email?: string;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  created_at: string;
}

/** A signed-in session. The credential itself is an httpOnly cookie,
 *  so unlike Supabase's session there is no token to hand out. */
export interface Session {
  user: User;
}

/** Why an auth call failed, for the pages to translate
 *  (messages/*.json → AuthErrors). `message` is an English fallback. */
export type AuthErrorCode =
  | "invalid_credentials"
  | "email_not_verified"
  | "email_in_use"
  | "weak_password"
  | "invalid_email"
  | "too_many_requests"
  | "requires_recent_login"
  | "network"
  | "session_failed"
  | "unknown";

export interface AuthError {
  message: string;
  status?: number;
  code?: AuthErrorCode;
}

export type AuthChangeEvent = "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT";

type AuthResult<T> = Promise<{ data: T; error: AuthError | null }>;

export interface AuthClient {
  getUser(): AuthResult<{ user: User | null }>;
  getSession(): AuthResult<{ session: Session | null }>;
  onAuthStateChange(
    callback: (event: AuthChangeEvent, session: Session | null) => void,
  ): { data: { subscription: { unsubscribe(): void } } };
  signOut(options?: { scope?: "global" | "local" | "others" }): Promise<{
    error: AuthError | null;
  }>;
  signInWithPassword(credentials: {
    email: string;
    password: string;
  }): AuthResult<{ user: User | null; session: Session | null }>;
  signUp(credentials: {
    email: string;
    password: string;
    options?: { data?: Record<string, unknown>; emailRedirectTo?: string };
  }): AuthResult<{ user: User | null; session: Session | null }>;
  resetPasswordForEmail(
    email: string,
    options?: { redirectTo?: string },
  ): AuthResult<Record<string, never> | null>;
  updateUser(attributes: {
    email?: string;
    password?: string;
    data?: Record<string, unknown>;
  }): AuthResult<{ user: User | null }>;
}

// ------------------------------------------------------------------
// Storage: Cloud Storage for Firebase. The browser client uploads with
// the Firebase SDK (src/lib/firebase/storage.ts), the service-role
// client over the Cloud Storage API (src/lib/storage/admin-storage.ts).
// ------------------------------------------------------------------

export interface StorageError {
  message: string;
}

export interface StorageBucket {
  upload(
    path: string,
    body: Blob | ArrayBuffer | ArrayBufferView,
    options?: { cacheControl?: string; upsert?: boolean; contentType?: string },
  ): Promise<{ data: { path: string } | null; error: StorageError | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
  remove(paths: string[]): Promise<{ data: unknown[] | null; error: StorageError | null }>;
}

export interface StorageClient {
  from(bucket: string): StorageBucket;
}

const STORAGE_PENDING: StorageError = {
  message: "File storage is not available on this client. Upload from the browser or use the service-role client.",
};

/** For clients with no storage of their own: the per-request server
 *  client (nothing server-side uploads as the user) and the throwaway
 *  instance client components get while rendering on the server. */
export const pendingStorage: StorageClient = {
  from: () => ({
    upload: async () => ({ data: null, error: STORAGE_PENDING }),
    getPublicUrl: () => ({ data: { publicUrl: "" } }),
    remove: async () => ({ data: null, error: STORAGE_PENDING }),
  }),
};

// ------------------------------------------------------------------
// Realtime (Firestore signals land in phase 4)
// ------------------------------------------------------------------

export type RealtimeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export interface RealtimePostgresChangesPayload {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  schema: string;
  table: string;
  commit_timestamp: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  old: Record<string, any>;
  errors: string[] | null;
}

export interface PostgresChangesFilter {
  event: "*" | "INSERT" | "UPDATE" | "DELETE";
  schema: string;
  table: string;
  filter?: string;
}

/**
 * Same surface as supabase-js's channel for `postgres_changes`. Until
 * the phase 4 transport exists it records its listeners and never
 * fires, and `subscribe` never reports SUBSCRIBED — screens load their
 * data normally, they just don't update live yet.
 */
export class RealtimeChannel {
  readonly listeners: Array<{
    filter: PostgresChangesFilter;
    callback: (payload: RealtimePostgresChangesPayload) => void;
  }> = [];

  constructor(readonly topic: string) {}

  on(
    _type: "postgres_changes",
    filter: PostgresChangesFilter,
    callback: (payload: RealtimePostgresChangesPayload) => void,
  ): this {
    this.listeners.push({ filter, callback });
    return this;
  }

  subscribe(_callback?: (status: RealtimeStatus, err?: Error) => void): this {
    return this;
  }

  async unsubscribe(): Promise<"ok"> {
    this.listeners.length = 0;
    return "ok";
  }
}

// ------------------------------------------------------------------
// The client
// ------------------------------------------------------------------

export interface AppClientOptions {
  /** Adds the credentials for the target PostgREST (see server.ts / admin.ts).
   *  The browser leaves it unset: its cookie rides along to /api/rest. */
  fetch?: Fetch;
  auth: AuthClient;
  storage?: StorageClient;
}

export class AppClient extends PostgrestClient {
  readonly auth: AuthClient;
  readonly storage: StorageClient;
  private readonly channels = new Set<RealtimeChannel>();

  constructor(url: string, options: AppClientOptions) {
    super(url, { fetch: options.fetch });
    this.auth = options.auth;
    this.storage = options.storage ?? pendingStorage;
  }

  channel(name: string): RealtimeChannel {
    const channel = new RealtimeChannel(name);
    this.channels.add(channel);
    return channel;
  }

  async removeChannel(channel: RealtimeChannel): Promise<"ok"> {
    this.channels.delete(channel);
    return channel.unsubscribe();
  }

  async removeAllChannels(): Promise<"ok"[]> {
    const all = [...this.channels];
    this.channels.clear();
    return Promise.all(all.map((c) => c.unsubscribe()));
  }
}

/** Kept under the supabase-js name so the dozens of helpers typed
 *  `(supabase: SupabaseClient, …)` only change their import line. */
export type SupabaseClient = AppClient;

/** Auth for clients that never carry a user (service role). */
export const noUserAuth: AuthClient = (() => {
  const unsupported = { message: "No user session on this client." };
  return {
    getUser: async () => ({ data: { user: null }, error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: unsupported }),
    signInWithPassword: async () => ({ data: { user: null, session: null }, error: unsupported }),
    signUp: async () => ({ data: { user: null, session: null }, error: unsupported }),
    resetPasswordForEmail: async () => ({ data: null, error: unsupported }),
    updateUser: async () => ({ data: { user: null }, error: unsupported }),
  };
})();
