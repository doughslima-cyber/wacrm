import { cookies } from 'next/headers'

import { getSessionUser, SESSION_COOKIE } from '@/lib/auth/session'
import { AppClient, noUserAuth, type AuthClient, type User } from './app-client'
import { postgrestUrl, signedPostgrestFetch } from './postgrest'

// Per-request client for server components and route handlers. Talks
// straight to the private PostgREST as the signed-in user (RLS applies),
// or as `anon` when there is no valid session cookie.
export async function createClient() {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(SESSION_COOKIE)?.value

  let userPromise: Promise<User | null> | undefined
  const currentUser = () => (userPromise ??= getSessionUser(sessionCookie))

  return new AppClient(postgrestUrl(), {
    fetch: signedPostgrestFetch(async () => {
      const user = await currentUser()
      return user ? { role: 'authenticated', sub: user.id } : null
    }),
    auth: serverAuth(currentUser),
  })
}

// Sign-in / sign-up / password changes happen in the browser; on the
// server only the "who is this" half of supabase-js's auth exists.
function serverAuth(currentUser: () => Promise<User | null>): AuthClient {
  return {
    ...noUserAuth,
    async getUser() {
      try {
        const user = await currentUser()
        return {
          data: { user },
          error: user ? null : { message: 'Auth session missing!', status: 401 },
        }
      } catch (err) {
        return { data: { user: null }, error: { message: (err as Error).message, status: 500 } }
      }
    },
    async getSession() {
      try {
        const user = await currentUser()
        return { data: { session: user ? { user } : null }, error: null }
      } catch (err) {
        return { data: { session: null }, error: { message: (err as Error).message, status: 500 } }
      }
    },
  }
}
