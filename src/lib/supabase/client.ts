import { publicObjectUrl } from '@/lib/storage/buckets'
import {
  AppClient,
  type AuthChangeEvent,
  type AuthClient,
  type RealtimeTransport,
  type Session,
  type StorageClient,
  type User,
} from './app-client'

// Singleton instance — one client shared across the whole browser session.
// Queries go to /api/rest on this same origin; the session cookie rides
// along and the route swaps it for a PostgREST JWT (docs/firebase-migration.md §3.2).
let browserClient: AppClient | undefined

export function createClient(): AppClient {
  if (browserClient) return browserClient

  // Client components also render once on the server, where there is no
  // window. That instance is never queried (fetches run in effects), so
  // it only needs a valid URL and is not kept.
  if (typeof window === 'undefined') {
    return new AppClient('http://localhost/api/rest', { auth: browserAuth() })
  }

  browserClient = new AppClient(`${window.location.origin}/api/rest`, {
    auth: browserAuth(),
    storage: browserStorage,
    realtime: browserRealtime,
  })
  return browserClient
}

// ------------------------------------------------------------------
// Realtime: `channel().on('postgres_changes', …)` is served by Firestore
// signals plus a fetch of the row through /api/rest
// (src/lib/firebase/realtime.ts, loaded on the first subscribe).
// ------------------------------------------------------------------

const realtimeOps = () => import('@/lib/firebase/realtime')

const browserRealtime: RealtimeTransport = {
  join(channel, onStatus) {
    let leave: (() => void) | null = null
    let left = false
    realtimeOps().then(
      (ops) => {
        if (!left) leave = ops.join(createClient(), channel, onStatus)
      },
      (err) => {
        if (!left) onStatus('CHANNEL_ERROR', err instanceof Error ? err : new Error(String(err)))
      },
    )
    return () => {
      left = true
      leave?.()
    }
  },
}

// ------------------------------------------------------------------
// Storage: uploads go straight from the browser to Cloud Storage for
// Firebase, authorized by storage.rules (src/lib/firebase/storage.ts,
// loaded on first use). Public URLs need no SDK.
// ------------------------------------------------------------------

const storageOps = () => import('@/lib/firebase/storage')

const loadFailed = (err: unknown) => ({
  data: null,
  error: { message: (err as Error)?.message || 'Could not load file storage.' },
})

const browserStorage: StorageClient = {
  from: (bucket) => ({
    upload: (path, body, options) =>
      storageOps().then((ops) => ops.upload(bucket, path, body, options), loadFailed),
    getPublicUrl: (path) => ({ data: { publicUrl: publicObjectUrl(bucket, path) } }),
    remove: (paths) => storageOps().then((ops) => ops.remove(bucket, paths), loadFailed),
  }),
}

// ------------------------------------------------------------------
// Auth: the session is the httpOnly cookie the server holds; sign-in,
// sign-up and password flows run on the Firebase SDK
// (src/lib/firebase/auth-flows.ts, loaded on first use).
// ------------------------------------------------------------------

const flows = () => import('@/lib/firebase/auth-flows')

/** How long a fetched session is reused before asking the server again. */
const SESSION_TTL_MS = 60_000

/** Renew the cookie when it has less than this left. */
const RENEW_BEFORE_MS = 3 * 24 * 3600_000

function browserAuth(): AuthClient {
  let cached: { user: User | null; at: number } | null = null
  let inFlight: Promise<User | null> | null = null
  let renewing = false
  const listeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>()

  const toSession = (user: User | null): Session | null => (user ? { user } : null)

  const maybeRenew = (user: User | null, expiresAt: number | null | undefined) => {
    if (!user || !expiresAt || renewing || expiresAt - Date.now() > RENEW_BEFORE_MS) return
    renewing = true
    flows()
      .then((f) => f.renewSession(user.email))
      .catch(() => {})
      .finally(() => {
        renewing = false
      })
  }

  const currentUser = (): Promise<User | null> => {
    if (cached && Date.now() - cached.at < SESSION_TTL_MS) return Promise.resolve(cached.user)
    inFlight ??= fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => {
        const body = res.ok
          ? ((await res.json()) as { user: User | null; expiresAt?: number | null })
          : { user: null }
        cached = { user: body.user, at: Date.now() }
        maybeRenew(body.user, body.expiresAt)
        return body.user
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const emit = (event: AuthChangeEvent, user: User | null) => {
    for (const listener of listeners) listener(event, toSession(user))
  }

  const signedIn = (user: User) => {
    cached = { user, at: Date.now() }
    emit('SIGNED_IN', user)
  }

  return {
    async getUser() {
      try {
        const user = await currentUser()
        return { data: { user }, error: user ? null : { message: 'Auth session missing!', status: 401 } }
      } catch (err) {
        return { data: { user: null }, error: { message: (err as Error).message } }
      }
    },
    async getSession() {
      try {
        return { data: { session: toSession(await currentUser()) }, error: null }
      } catch (err) {
        return { data: { session: null }, error: { message: (err as Error).message } }
      }
    },
    onAuthStateChange(callback) {
      listeners.add(callback)
      // supabase-js fires INITIAL_SESSION right after subscribing.
      currentUser()
        .then((user) => listeners.has(callback) && callback('INITIAL_SESSION', toSession(user)))
        .catch(() => {})
      return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } }
    },
    async signOut(options) {
      const scope = options?.scope ?? 'local'
      const res = await fetch(`/api/auth/session?scope=${scope}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      if (!res.ok) return { error: { message: `Sign-out failed (${res.status})`, status: res.status } }
      await (await flows()).signOutFirebase()
      cached = { user: null, at: Date.now() }
      emit('SIGNED_OUT', null)
      return { error: null }
    },
    async signInWithPassword({ email, password }) {
      const { value: user, error } = await (await flows()).signIn(email, password)
      if (!user) return { data: { user: null, session: null }, error }
      signedIn(user)
      return { data: { user, session: { user } }, error: null }
    },
    async signUp({ email, password, options }) {
      const fullName = typeof options?.data?.full_name === 'string' ? options.data.full_name : ''
      const { error } = await (await flows()).signUp(email, password, fullName, options?.emailRedirectTo)
      // As with email confirmations on: no session until the link is clicked.
      return { data: { user: null, session: null }, error }
    },
    async resetPasswordForEmail(email, options) {
      const { error } = await (await flows()).sendPasswordReset(email, options?.redirectTo)
      return { data: error ? null : {}, error }
    },
    async updateUser(attributes) {
      const f = await flows()
      if (attributes.password) {
        const { value: user, error } = await f.changePassword(attributes.password)
        if (!user) return { data: { user: null }, error }
        signedIn(user)
        return { data: { user }, error: null }
      }
      if (attributes.email) {
        const { error } = await f.changeEmail(attributes.email)
        return { data: { user: error ? null : (cached?.user ?? null) }, error }
      }
      return { data: { user: null }, error: { message: 'Only email and password can be updated.' } }
    },
  }
}
