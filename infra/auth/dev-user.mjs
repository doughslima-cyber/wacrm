// Creates (or reuses) a test user without going through the emails and
// prints a session cookie for it. Handy for scripts and for a second
// user in isolation tests; the app's own sign-up (/signup → email link
// → /login) does the same for real users.
//
//   1. Firebase Auth user via the Identity Toolkit REST API (email +
//      password; needs the Email/Password provider enabled), marked as
//      email-verified — the app refuses unverified sign-ins.
//   2. Matching auth.users row. The upstream on_auth_user_created
//      trigger then creates the profile and a personal account, exactly
//      as a Supabase signup did.
//   3. A session cookie from that user's ID token. Set it in the browser
//      as `__session` on the app's origin (DevTools → Application →
//      Cookies) and the app treats you as signed in.
//
// Env:
//   FIREBASE_API_KEY           web API key (firebase apps:sdkconfig WEB)
//   DEV_USER_EMAIL             e.g. dev@example.com
//   DEV_USER_PASSWORD          at least 6 characters
//   DEV_USER_NAME              optional full name for the profile
//   INSTANCE_CONNECTION_NAME,
//   PGPASSWORD,
//   GOOGLE_OAUTH_ACCESS_TOKEN  same as db/migrate.mjs; the access token
//                              also signs the createSessionCookie call
//   FIREBASE_PROJECT           default: crm-zap-cbd5d

import { openDb } from '../db/spike/db.mjs'

const PROJECT = process.env.FIREBASE_PROJECT || 'crm-zap-cbd5d'
const API_KEY = required('FIREBASE_API_KEY')
const EMAIL = required('DEV_USER_EMAIL')
const PASSWORD = required('DEV_USER_PASSWORD')
const NAME = process.env.DEV_USER_NAME || EMAIL.split('@')[0]
const ACCESS_TOKEN = required('GOOGLE_OAUTH_ACCESS_TOKEN')

/** Firebase caps session cookies at 14 days. */
const SESSION_SECONDS = 14 * 24 * 3600

function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`missing env var ${name}`)
    process.exit(1)
  }
  return value
}

async function identityToolkit(method, body) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  })
  const json = await res.json()
  return res.ok ? { ok: true, ...json } : { ok: false, code: json.error?.message }
}

async function firebaseSignIn() {
  const created = await identityToolkit('signUp', { email: EMAIL, password: PASSWORD })
  if (created.ok) return { ...created, created: true }
  if (created.code !== 'EMAIL_EXISTS') throw new Error(`signUp failed: ${created.code}`)
  const signedIn = await identityToolkit('signInWithPassword', { email: EMAIL, password: PASSWORD })
  if (!signedIn.ok) throw new Error(`signInWithPassword failed: ${signedIn.code}`)
  return { ...signedIn, created: false }
}

async function createSessionCookie(idToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}:createSessionCookie`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      'x-goog-user-project': PROJECT,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ idToken, validDuration: String(SESSION_SECONDS) }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`createSessionCookie failed: ${json.error?.message ?? res.status}`)
  return json.sessionCookie
}

async function markEmailVerified(localId) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      'x-goog-user-project': PROJECT,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ localId, emailVerified: true, displayName: NAME }),
  })
  if (!res.ok) throw new Error(`accounts:update failed: ${(await res.json()).error?.message ?? res.status}`)
}

const first = await firebaseSignIn()
await markEmailVerified(first.localId)
// Sign in again: only a new ID token carries email_verified: true.
const firebase = { ...(await firebaseSignIn()), created: first.created }

const db = await openDb()
let row
try {
  const { rows } = await db.client.query(
    `INSERT INTO auth.users (firebase_uid, email, email_confirmed_at, raw_user_meta_data)
     VALUES ($1, $2, now(), jsonb_build_object('full_name', $3::text))
     ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email, updated_at = now()
     RETURNING id`,
    [firebase.localId, EMAIL, NAME],
  )
  const userId = rows[0].id
  const profile = await db.client.query(
    `SELECT p.account_id, p.account_role, a.name AS account_name
       FROM public.profiles p LEFT JOIN public.accounts a ON a.id = p.account_id
      WHERE p.user_id = $1`,
    [userId],
  )
  row = { userId, ...profile.rows[0] }
} finally {
  await db.close()
}

const cookie = await createSessionCookie(firebase.idToken)

console.log(`firebase uid : ${firebase.localId}${firebase.created ? ' (new)' : ''}`)
console.log(`auth.users   : ${row.userId}`)
console.log(`account      : ${row.account_id ?? '—'} (${row.account_role ?? 'no role'}) ${row.account_name ?? ''}`)
console.log('\nSet this as the `__session` cookie on the app origin:\n')
console.log(cookie)
