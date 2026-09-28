import {
  AppClient,
  type AuthChangeEvent,
  type AuthClient,
  type AuthError,
  type Session,
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

  browserClient = new AppClient(`${window.location.origin}/api/rest`, { auth: browserAuth() })
  return browserClient
}

// ------------------------------------------------------------------
// Auth: reads the session the server holds in the httpOnly cookie.
// Sign-in, sign-up and password flows move to the Firebase SDK in phase 2.
// ------------------------------------------------------------------

const PENDING: AuthError = {
  message: 'Sign-in is being moved to Firebase Authentication (migration phase 2).',
}

/** How long a fetched session is reused before asking the server again. */
const SESSION_TTL_MS = 60_000

function browserAuth(): AuthClient {
  let cached: { user: User | null; at: number } | null = null
  let inFlight: Promise<User | null> | null = null
  const listeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>()

  const toSession = (user: User | null): Session | null => (user ? { user } : null)

  const currentUser = (): Promise<User | null> => {
    if (cached && Date.now() - cached.at < SESSION_TTL_MS) return Promise.resolve(cached.user)
    inFlight ??= fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => {
        const user = res.ok ? ((await res.json()) as { user: User | null }).user : null
        cached = { user, at: Date.now() }
        return user
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const emit = (event: AuthChangeEvent, user: User | null) => {
    for (const listener of listeners) listener(event, toSession(user))
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
      cached = { user: null, at: Date.now() }
      emit('SIGNED_OUT', null)
      return { error: null }
    },
    signInWithPassword: async () => ({ data: { user: null, session: null }, error: PENDING }),
    signUp: async () => ({ data: { user: null, session: null }, error: PENDING }),
    resetPasswordForEmail: async () => ({ data: null, error: PENDING }),
    updateUser: async () => ({ data: { user: null }, error: PENDING }),
  }
}
