// Cross-account isolation test (docs/firebase-migration.md, phase 6).
//
//   cd infra && npm run isolation:test
//
// Two users, each in their own personal account, against a running app
// (default: `npm run dev` on localhost:3000, on the dev stack of
// infra/vps/dev.sh). A seeds data in its account the way the app does;
// B then tries to read, change and delete it through every door the app
// has: /api/rest (PostgREST behind the proxy), the /api/* routes, the
// public API (/api/v1, with B's API key), Cloud Storage and Firestore.
// Every attempt must fail, and A's data must come out unchanged.
//
// The users are isolation-a@example.com and isolation-b@example.com,
// created on the first run (Identity Toolkit + the app's own
// /api/auth/session, which creates auth.users, profile and account) and
// reused afterwards. Their passwords are reset on every run, so nothing
// secret is stored anywhere. Use them only against a dev database: the
// Firebase project is shared (see infra/vps/dev.sh).
//
// Env:
//   APP_URL                    default http://localhost:3000
//   FIREBASE_API_KEY           default: NEXT_PUBLIC_FIREBASE_API_KEY in ../.env.local
//   GOOGLE_OAUTH_ACCESS_TOKEN  default: `gcloud auth print-access-token`
//                              (marks the users verified, resets passwords)
//   FIREBASE_PROJECT           default crm-zap-cbd5d
//   STORAGE_BUCKET             default: NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET in ../.env.local

import { execSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { attackRoutes, seedRoutes } from './routes.mjs'

const ENV_LOCAL = fileURLToPath(new URL('../../.env.local', import.meta.url))
const localEnv = existsSync(ENV_LOCAL)
  ? Object.fromEntries(
      readFileSync(ENV_LOCAL, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    )
  : {}

const APP = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
const PROJECT = process.env.FIREBASE_PROJECT || 'crm-zap-cbd5d'
const API_KEY = process.env.FIREBASE_API_KEY || localEnv.NEXT_PUBLIC_FIREBASE_API_KEY
const BUCKET = process.env.STORAGE_BUCKET || localEnv.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
const ACCESS_TOKEN =
  process.env.GOOGLE_OAUTH_ACCESS_TOKEN || execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim()
if (!API_KEY || !BUCKET) {
  console.error('missing FIREBASE_API_KEY / STORAGE_BUCKET (or .env.local)')
  process.exit(1)
}

// ------------------------------------------------------------------
// Results
// ------------------------------------------------------------------

const results = []
let section = ''

function check(name, ok, detail = '') {
  results.push({ section, name, ok: Boolean(ok), detail })
  if (!ok) console.log(`  FAIL ${section} › ${name}${detail ? ` — ${detail}` : ''}`)
}

// Known upstream behaviour (same RLS as on Supabase): reported, but it
// doesn't fail the run. See docs/firebase-migration.md, phase 6.
const warnings = []
function warn(name, ok, detail = '') {
  if (ok) return check(name, true)
  warnings.push({ section, name, detail })
  console.log(`  WARN ${section} › ${name}${detail ? ` — ${detail}` : ''}`)
}

function begin(title) {
  section = title
  console.log(`\n# ${title}`)
}

const short = (value, max = 160) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ------------------------------------------------------------------
// Firebase users and app sessions
// ------------------------------------------------------------------

async function identityToolkit(method, body) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  })
  const json = await res.json()
  return res.ok ? { ok: true, ...json } : { ok: false, code: json.error?.message }
}

async function adminAccounts(method, body) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      'x-goog-user-project': PROJECT,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`accounts${method} failed: ${json.error?.message ?? res.status}`)
  return json
}

/** Creates or reuses the Firebase user, verified, with a fresh password. */
async function firebaseUser(email, name) {
  const password = randomBytes(18).toString('base64url')
  const created = await identityToolkit('signUp', { email, password })
  let localId = created.localId
  if (!created.ok) {
    if (created.code !== 'EMAIL_EXISTS') throw new Error(`signUp ${email}: ${created.code}`)
    const found = await adminAccounts(':lookup', { email: [email] })
    localId = found.users?.[0]?.localId
    if (!localId) throw new Error(`lookup ${email} found nobody`)
  }
  await adminAccounts(':update', { localId, password, emailVerified: true, displayName: name })
  return { email, password, localId }
}

async function signIn(user) {
  const res = await identityToolkit('signInWithPassword', { email: user.email, password: user.password })
  if (!res.ok) throw new Error(`signIn ${user.email}: ${res.code}`)
  return res.idToken
}

/** Signs in through the app, like the login page: POST /api/auth/session. */
async function appSession(user) {
  const res = await fetch(`${APP}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: await signIn(user) }),
  })
  if (!res.ok) throw new Error(`session ${user.email}: ${res.status} ${await res.text()}`)
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('__session='))
  if (!cookie) throw new Error(`session ${user.email}: no __session cookie`)
  const me = await (await fetch(`${APP}/api/auth/session`, { headers: { cookie } })).json()
  // A new ID token carries the accountIds / userId claims the app just wrote.
  const idToken = await signIn(user)
  const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString())
  return { ...user, cookie, idToken, userId: me.user.id, claims }
}

// ------------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------------

async function call(who, method, path, { body, headers = {}, raw = false } = {}) {
  const init = { method, headers: { ...headers } }
  if (who?.cookie) init.headers.cookie = who.cookie
  if (body !== undefined) {
    init.headers['content-type'] ??= 'application/json'
    init.body = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)
  }
  const res = await fetch(`${APP}${path}`, init)
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = undefined
  }
  return { status: res.status, text, json, headers: res.headers, raw }
}

const REPR = { prefer: 'return=representation' }
const rest = {
  get: (who, table, query = '') => call(who, 'GET', `/api/rest/${table}${query ? `?${query}` : ''}`),
  insert: (who, table, row) => call(who, 'POST', `/api/rest/${table}`, { body: row, headers: REPR }),
  patch: (who, table, query, row) => call(who, 'PATCH', `/api/rest/${table}?${query}`, { body: row, headers: REPR }),
  delete: (who, table, query) => call(who, 'DELETE', `/api/rest/${table}?${query}`, { headers: REPR }),
  rpc: (who, fn, args) => call(who, 'POST', `/api/rest/rpc/${fn}`, { body: args }),
}

async function mustInsert(who, table, row) {
  const res = await rest.insert(who, table, row)
  if (res.status !== 201 || !Array.isArray(res.json) || res.json.length !== 1) {
    throw new Error(`seed ${table}: ${res.status} ${short(res.text, 400)}`)
  }
  return res.json[0]
}

/** No row of the response mentions any of the victim's ids. */
function leaks(res, secrets) {
  return secrets.filter((s) => res.text.includes(s))
}

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

begin('setup')
const [fa, fb, fc] = await Promise.all([
  firebaseUser('isolation-a@example.com', 'Isolation A'),
  firebaseUser('isolation-b@example.com', 'Isolation B'),
  // C joins A's account and is removed again (the ex-member case).
  firebaseUser('isolation-c@example.com', 'Isolation C'),
])
const A = await appSession(fa)
const B = await appSession(fb)
const C = await appSession(fc)

const accountOf = async (who) => (await rest.get(who, 'profiles', `user_id=eq.${who.userId}&select=account_id,account_role`)).json?.[0]
const profA = await accountOf(A)
const profB = await accountOf(B)
A.accountId = profA?.account_id
B.accountId = profB?.account_id
console.log(`A ${A.userId} account ${A.accountId} (${profA?.account_role})`)
console.log(`B ${B.userId} account ${B.accountId} (${profB?.account_role})`)
check('both users have their own account', A.accountId && B.accountId && A.accountId !== B.accountId)
check('A is owner of its account', profA?.account_role === 'owner', profA?.account_role)
check('A claim accountIds = [A account]', JSON.stringify(A.claims.accountIds) === JSON.stringify([A.accountId]))
check('B claim accountIds = [B account]', JSON.stringify(B.claims.accountIds) === JSON.stringify([B.accountId]))
check('claim userId matches auth.users', A.claims.userId === A.userId && B.claims.userId === B.userId)
if (!A.accountId || !B.accountId || A.accountId === B.accountId) {
  console.error('cannot continue without two separate accounts')
  process.exit(1)
}

// ------------------------------------------------------------------
// Seed A's account through /api/rest, as the browser does
// ------------------------------------------------------------------

begin('seed A')
// Server clock before seeding, for the realtime log check below.
const clock0 = (await rest.rpc(A, 'realtime_changes_since', { p_after: null })).json?.now
const tag8 = randomUUID().slice(0, 8)
const own = { user_id: A.userId, account_id: A.accountId }
const seed = {}
seed.contacts = await mustInsert(A, 'contacts', { ...own, phone: `+5511${Date.now().toString().slice(-8)}`, name: `Iso A ${tag8}` })
seed.tags = await mustInsert(A, 'tags', { ...own, name: `iso-${tag8}`, color: '#ff0000' })
seed.contact_tags = await mustInsert(A, 'contact_tags', { contact_id: seed.contacts.id, tag_id: seed.tags.id })
seed.pipelines = await mustInsert(A, 'pipelines', { ...own, name: `Iso pipeline ${tag8}` })
seed.pipeline_stages = await mustInsert(A, 'pipeline_stages', { pipeline_id: seed.pipelines.id, name: 'Novo', position: 0, color: '#00ff00' })
seed.conversations = await mustInsert(A, 'conversations', { ...own, contact_id: seed.contacts.id, status: 'open' })
seed.messages = await mustInsert(A, 'messages', {
  conversation_id: seed.conversations.id,
  sender_type: 'agent',
  sender_id: A.userId,
  content_type: 'text',
  content_text: `segredo de A ${tag8}`,
  status: 'sent',
})
seed.deals = await mustInsert(A, 'deals', {
  ...own,
  pipeline_id: seed.pipelines.id,
  stage_id: seed.pipeline_stages.id,
  contact_id: seed.contacts.id,
  title: `Iso deal ${tag8}`,
  value: 1000,
})
seed.contact_notes = await mustInsert(A, 'contact_notes', { ...own, contact_id: seed.contacts.id, note_text: `nota de A ${tag8}` })
seed.custom_fields = await mustInsert(A, 'custom_fields', { ...own, field_name: `iso_${tag8}`, field_type: 'text' })
seed.contact_custom_values = await mustInsert(A, 'contact_custom_values', {
  contact_id: seed.contacts.id,
  custom_field_id: seed.custom_fields.id,
  value: 'valor de A',
})
seed.message_templates = await mustInsert(A, 'message_templates', {
  ...own,
  name: `iso_${tag8}`,
  category: 'Marketing',
  body_text: 'Olá {{1}}',
})
seed.quick_replies = await mustInsert(A, 'quick_replies', {
  account_id: A.accountId,
  user_id: A.userId,
  title: `Iso QR ${tag8}`,
  kind: 'text',
  content_text: 'resposta rápida de A',
})
seed.message_reactions = await mustInsert(A, 'message_reactions', {
  message_id: seed.messages.id,
  conversation_id: seed.conversations.id,
  actor_type: 'agent',
  actor_id: A.userId,
  emoji: '👍',
})
// Rows created by the app's own server routes (routes.mjs) join `seed`;
// the REST attacks and the final comparison cover them too.
const { v1 } = await seedRoutes({ A, B, call, rest, seed, tag8 })
for (const [key, row] of Object.entries(seed)) console.log(`  ${key} ${row.id}`)

// seed keys that aren't table names.
const TABLE_OF = { quick_replies_route: 'quick_replies' }
// Columns that move when A itself uses the row.
const VOLATILE = { api_keys: ['last_used_at'] }
const snapshot = (table, rows) =>
  JSON.stringify((rows ?? []).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE[table]?.includes(k)))))

// ------------------------------------------------------------------
// /api/rest: B against A's rows
// ------------------------------------------------------------------

begin('/api/rest — B reads, changes and deletes A rows')
// A harmless column per table, for the PATCH attempt.
const PATCH_COLUMN = {
  contacts: { name: 'pwned' },
  tags: { name: 'pwned' },
  contact_tags: { tag_id: randomUUID() },
  pipelines: { name: 'pwned' },
  pipeline_stages: { name: 'pwned' },
  conversations: { status: 'closed' },
  messages: { content_text: 'pwned' },
  deals: { title: 'pwned' },
  contact_notes: { note_text: 'pwned' },
  custom_fields: { field_name: 'pwned' },
  contact_custom_values: { value: 'pwned' },
  message_templates: { body_text: 'pwned' },
  quick_replies: { title: 'pwned' },
  message_reactions: { emoji: '💀' },
  automations: { name: 'pwned' },
  flows: { name: 'pwned' },
  ai_knowledge_documents: { title: 'pwned' },
  api_keys: { name: 'pwned' },
  webhook_endpoints: { url: 'https://example.com/pwned' },
  account_invitations: { role: 'admin' },
  accounts: { name: 'pwned' },
  profiles: { full_name: 'pwned' },
  ai_configs: { model: 'pwned' },
  whatsapp_config: { status: 'pwned' },
  broadcasts: { name: 'pwned' },
  notifications: { title: 'pwned' },
}
seed.accounts ??= { id: A.accountId }

const before = {}
for (const [seedKey, row] of Object.entries(seed)) {
  const table = TABLE_OF[seedKey] ?? seedKey
  const key = table === 'profiles' ? 'user_id' : 'id'
  const q = `${key}=eq.${row[key] ?? row.id}`
  before[seedKey] = (await rest.get(A, table, q)).json
  // Control: the same query as A finds the row, so an empty answer to B means RLS, not a bad query.
  check(`${table}: A GET by id (control)`, Array.isArray(before[seedKey]) && before[seedKey].length === 1, short(before[seedKey]))

  const read = await rest.get(B, table, q)
  check(`${table}: B GET by id`, read.status === 200 && Array.isArray(read.json) && read.json.length === 0, `${read.status} ${short(read.text)}`)

  const patch = PATCH_COLUMN[table]
  if (patch) {
    const res = await rest.patch(B, table, q, patch)
    const noop = (res.status === 200 && Array.isArray(res.json) && res.json.length === 0) || res.status >= 400
    check(`${table}: B PATCH by id`, noop, `${res.status} ${short(res.text)}`)
  }
  if (table !== 'accounts' && table !== 'profiles') {
    const res = await rest.delete(B, table, q)
    const noop = (res.status === 200 && Array.isArray(res.json) && res.json.length === 0) || res.status >= 400
    check(`${table}: B DELETE by id`, noop, `${res.status} ${short(res.text)}`)
  }
}

begin('/api/rest — B writes into A account')
const intoA = { user_id: B.userId, account_id: A.accountId }
const INSERTS = {
  contacts: { ...intoA, phone: '+5511900000001', name: 'intruso' },
  tags: { ...intoA, name: 'intruso', color: '#000000' },
  pipelines: { ...intoA, name: 'intruso' },
  conversations: { ...intoA, contact_id: seed.contacts.id, status: 'open' },
  contact_notes: { ...intoA, contact_id: seed.contacts.id, note_text: 'intruso' },
  custom_fields: { ...intoA, field_name: 'intruso', field_type: 'text' },
  message_templates: { ...intoA, name: 'intruso', category: 'Marketing', body_text: 'x' },
  quick_replies: { ...intoA, title: 'intruso', kind: 'text', content_text: 'x' },
  // Child rows hanging off A's parents.
  contact_tags: { contact_id: seed.contacts.id, tag_id: seed.tags.id },
  pipeline_stages: { pipeline_id: seed.pipelines.id, name: 'intruso', position: 9, color: '#000000' },
  messages: { conversation_id: seed.conversations.id, sender_type: 'agent', sender_id: B.userId, content_type: 'text', content_text: 'intruso', status: 'sent' },
  contact_custom_values: { contact_id: seed.contacts.id, custom_field_id: seed.custom_fields.id, value: 'intruso' },
  message_reactions: { message_id: seed.messages.id, conversation_id: seed.conversations.id, actor_type: 'agent', actor_id: B.userId, emoji: '💀' },
  deals: { ...intoA, pipeline_id: seed.pipelines.id, stage_id: seed.pipeline_stages.id, title: 'intruso', value: 1 },
  notifications: { account_id: A.accountId, user_id: A.userId, type: 'mention', title: 'intruso' },
  member_presence: { user_id: B.userId, account_id: A.accountId, status: 'online', last_seen_at: new Date().toISOString() },
  api_keys: { account_id: A.accountId, name: 'intruso', key_prefix: 'wacrm_xx', key_hash: 'x'.repeat(64), scopes: ['contacts:read'] },
  webhook_endpoints: { account_id: A.accountId, url: 'https://example.com/x', secret: 'x', events: ['message.received'] },
  ai_knowledge_documents: { account_id: A.accountId, title: 'intruso', content: 'x' },
  account_invitations: { account_id: A.accountId, role: 'admin', invited_by: B.userId },
  profiles: { user_id: B.userId, account_id: A.accountId, account_role: 'owner' },
}
for (const [table, row] of Object.entries(INSERTS)) {
  const res = await rest.insert(B, table, row)
  check(`${table}: B INSERT into A`, res.status >= 400, `${res.status} ${short(res.text)}`)
}
// Moving B's own profile into A's account.
{
  const res = await rest.patch(B, 'profiles', `user_id=eq.${B.userId}`, { account_id: A.accountId, account_role: 'owner' })
  const moved = Array.isArray(res.json) && res.json.some((r) => r.account_id === A.accountId)
  check('profiles: B moves itself into A account', !moved, `${res.status} ${short(res.text)}`)
}

begin('/api/rest — B references A rows from its own account')
// Rows in B's own account pointing at A's rows. The upstream policies
// (017_account_sharing.sql) only check the new row's account_id, so the
// FK takes any existing id: B can plant these if it knows the uuid
// (reported as WARN). What must hold is that B still can't read A's
// row through the reference. B's rows are removed afterwards.
{
  const planted = []
  const plant = async (table, row) => {
    const res = await rest.insert(B, table, row)
    if (res.status === 201) planted.push([table, res.json[0].id])
    return res
  }
  const bContact = await mustInsert(B, 'contacts', { user_id: B.userId, account_id: B.accountId, phone: `+5521${Date.now().toString().slice(-8)}`, name: 'B contato' })
  const bPipeline = await mustInsert(B, 'pipelines', { user_id: B.userId, account_id: B.accountId, name: 'B pipeline' })
  const dealRes = await plant('deals', {
    user_id: B.userId,
    account_id: B.accountId,
    pipeline_id: bPipeline.id,
    stage_id: seed.pipeline_stages.id,
    contact_id: seed.contacts.id,
    title: 'B deal apontando para A',
    value: 1,
  })
  warn('deals: B deal with A contact/stage refused', dealRes.status >= 400, `${dealRes.status}`)
  if (dealRes.status === 201) {
    const embed = await rest.get(B, 'deals', `id=eq.${dealRes.json[0].id}&select=id,contacts(*),pipeline_stages(*)`)
    check('deals: embed of A contact/stage stays hidden', embed.status === 200 && !embed.text.includes(seed.contacts.name) && !embed.text.includes('"Novo"'), short(embed.text))
  }
  const convRes = await plant('conversations', { user_id: B.userId, account_id: B.accountId, contact_id: seed.contacts.id, status: 'open' })
  warn('conversations: B conversation with A contact refused', convRes.status >= 400, `${convRes.status}`)
  if (convRes.status === 201) {
    const embed = await rest.get(B, 'conversations', `id=eq.${convRes.json[0].id}&select=id,contacts(*)`)
    check('conversations: embed of A contact stays hidden', embed.status === 200 && !embed.text.includes(seed.contacts.name) && !embed.text.includes(seed.contacts.phone), short(embed.text))
  }
  const tagRes = await plant('contact_tags', { contact_id: bContact.id, tag_id: seed.tags.id })
  warn('contact_tags: B contact tagged with A tag refused', tagRes.status >= 400, `${tagRes.status}`)
  if (tagRes.status === 201) {
    const embed = await rest.get(B, 'contact_tags', `id=eq.${tagRes.json[0].id}&select=id,tags(*)`)
    check('contact_tags: embed of A tag stays hidden', embed.status === 200 && !embed.text.includes(seed.tags.name), short(embed.text))
  }
  planted.push(['contacts', bContact.id], ['pipelines', bPipeline.id])
  for (const [table, id] of planted) await rest.delete(B, table, `id=eq.${id}`)
}

begin('/api/rest — whole-table sweep')
const secrets = [A.accountId, A.userId, ...Object.values(seed).map((r) => r.id).filter(Boolean), tag8]
const TABLES = [
  'accounts', 'profiles', 'account_invitations', 'member_presence', 'notifications',
  'contacts', 'contact_notes', 'contact_tags', 'contact_custom_values', 'custom_fields', 'tags',
  'conversations', 'messages', 'message_reactions', 'message_templates', 'quick_replies',
  'pipelines', 'pipeline_stages', 'deals',
  'broadcasts', 'broadcast_recipients',
  'automations', 'automation_steps', 'automation_logs', 'automation_pending_executions',
  'flows', 'flow_nodes', 'flow_runs', 'flow_run_events',
  'ai_configs', 'ai_knowledge_documents', 'ai_knowledge_chunks', 'ai_usage_log',
  'api_keys', 'webhook_endpoints', 'whatsapp_config',
]
for (const table of TABLES) {
  const asB = await rest.get(B, table, 'limit=1000')
  const found = leaks(asB, secrets)
  check(`${table}: B sees nothing of A`, asB.status < 500 && found.length === 0, found.length ? `leaks ${found.join(',')}` : `${asB.status}`)
  const anon = await rest.get(null, table, 'limit=1000')
  const anonFound = leaks(anon, secrets)
  const anonEmpty = anon.status >= 400 || (Array.isArray(anon.json) && anon.json.length === 0)
  check(`${table}: anonymous sees nothing`, anonEmpty && anonFound.length === 0, `${anon.status} ${short(anon.text)}`)
}
{
  const res = await rest.rpc(B, 'realtime_changes_since', { p_after: clock0 })
  check('rpc realtime_changes_since: B gets no A change', leaks(res, secrets).length === 0, `${res.status} ${short(res.text)}`)
  const mine = await rest.rpc(A, 'realtime_changes_since', { p_after: clock0 })
  check('rpc realtime_changes_since: A sees its own changes', mine.status === 200 && leaks(mine, [seed.messages.id]).length > 0, `${mine.status} ${short(mine.text)}`)
}

begin('/api/rest — proxy')
{
  // A forged token in Authorization must be ignored (dropped by the proxy).
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ role: 'service_role', sub: A.userId, exp: 9999999999 })).toString('base64url')
  const forged = `${header}.${payload}.${randomBytes(32).toString('base64url')}`
  const res = await call(null, 'GET', `/api/rest/contacts?id=eq.${seed.contacts.id}`, { headers: { authorization: `Bearer ${forged}` } })
  check('forged Authorization header ignored', leaks(res, [seed.contacts.id]).length === 0, `${res.status} ${short(res.text)}`)
  const asB = await call(B, 'GET', `/api/rest/contacts?id=eq.${seed.contacts.id}`, { headers: { authorization: `Bearer ${forged}` } })
  check('forged Authorization header ignored with B cookie', leaks(asB, [seed.contacts.id]).length === 0, `${asB.status} ${short(asB.text)}`)
  const bogus = await call({ cookie: '__session=not-a-session' }, 'GET', '/api/rest/contacts')
  check('bogus session cookie → 401', bogus.status === 401, `${bogus.status}`)
  const other = await call(B, 'GET', `/api/rest/..%2Fcontacts`)
  check('path traversal refused', other.status === 404 && leaks(other, secrets).length === 0, `${other.status}`)
  const cross = await call(B, 'POST', '/api/rest/contacts', {
    body: { user_id: B.userId, account_id: B.accountId, phone: '+5511900000009' },
    headers: { origin: 'https://evil.example', ...REPR },
  })
  check('cross-origin write refused', cross.status === 403, `${cross.status}`)
}

await attackRoutes({ A, B, C, call, rest, check, warn, begin, seed, tag8, short, v1 })

// ------------------------------------------------------------------
// Cloud Storage (Firebase rules, with the users' own ID tokens)
// ------------------------------------------------------------------

begin('Storage')
const STORAGE = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o`
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
const upload = (token, path) =>
  fetch(`${STORAGE}?name=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { authorization: `Firebase ${token}`, 'content-type': 'image/png' },
    body: png,
  })
const remove = (token, path) =>
  fetch(`${STORAGE}/${encodeURIComponent(path)}`, { method: 'DELETE', headers: { authorization: `Firebase ${token}` } })
{
  const ownPaths = {
    chat: `chat-media/account-${A.accountId}/isolation-${tag8}.png`,
    flow: `flow-media/account-${A.accountId}/isolation-${tag8}.png`,
    avatar: `avatars/${A.userId}/isolation-${tag8}.png`,
  }
  for (const [kind, path] of Object.entries(ownPaths)) {
    const put = await upload(A.idToken, path)
    check(`${kind}: A uploads to its own folder`, put.status === 200, `${put.status}`)
    const intrude = await upload(B.idToken, path.replace(`isolation-${tag8}`, `intruso-${tag8}`))
    check(`${kind}: B uploads into A folder`, intrude.status === 403, `${intrude.status}`)
    const overwrite = await upload(B.idToken, path)
    check(`${kind}: B overwrites A object`, overwrite.status === 403, `${overwrite.status}`)
    const del = await remove(B.idToken, path)
    check(`${kind}: B deletes A object`, del.status === 403, `${del.status}`)
    const list = await fetch(`${STORAGE}?prefix=${encodeURIComponent(path.slice(0, path.lastIndexOf('/') + 1))}`, {
      headers: { authorization: `Firebase ${B.idToken}` },
    })
    check(`${kind}: B lists A folder`, list.status === 403, `${list.status}`)
    const still = await fetch(`${STORAGE}/${encodeURIComponent(path)}?alt=media`)
    check(`${kind}: A object intact`, still.status === 200, `${still.status}`)
    const cleanup = await remove(A.idToken, path)
    check(`${kind}: A deletes its own object`, cleanup.status === 204, `${cleanup.status}`)
  }
}

// ------------------------------------------------------------------
// Firestore signals (realtime)
// ------------------------------------------------------------------

begin('Firestore')
{
  const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`
  const list = (token, accountId) =>
    fetch(`${FS}/signals/${accountId}/changes?pageSize=5`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  const own = await list(A.idToken, A.accountId)
  check('A reads its own signals', own.status === 200, `${own.status}`)
  const foreign = await list(B.idToken, A.accountId)
  check('B reads A signals', foreign.status === 403, `${foreign.status}`)
  const anon = await list(null, A.accountId)
  check('anonymous reads A signals', anon.status === 403 || anon.status === 401, `${anon.status}`)
  const write = await fetch(`${FS}/signals/${B.accountId}/changes?documentId=intruso-${tag8}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${B.idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { table: { stringValue: 'messages' } } }),
  })
  check('B writes a signal (even its own)', write.status === 403, `${write.status}`)
}

// ------------------------------------------------------------------
// A's data after all of it
// ------------------------------------------------------------------

begin('A data unchanged')
for (const [seedKey, row] of Object.entries(seed)) {
  const table = TABLE_OF[seedKey] ?? seedKey
  const key = table === 'profiles' ? 'user_id' : 'id'
  const now = (await rest.get(A, table, `${key}=eq.${row[key] ?? row.id}`)).json
  check(`${seedKey} unchanged`, snapshot(table, now) === snapshot(table, before[seedKey]), short(now))
}

// ------------------------------------------------------------------
// Sessions (last: this revokes B's)
// ------------------------------------------------------------------

begin('sessions')
{
  const out = await call(B, 'DELETE', '/api/auth/session?scope=global')
  check('B signs out everywhere', out.status === 200 || out.status === 204, `${out.status}`)
  const stale = await call(B, 'GET', `/api/rest/contacts?account_id=eq.${B.accountId}`)
  check('revoked cookie → 401 on /api/rest', stale.status === 401, `${stale.status}`)
  const staleRoute = await call(B, 'GET', '/api/quick-replies')
  check('revoked cookie refused on /api/*', staleRoute.status === 401 || staleRoute.status === 403, `${staleRoute.status}`)
}

// ------------------------------------------------------------------

const failed = results.filter((r) => !r.ok)
const bySection = {}
for (const r of results) {
  bySection[r.section] ??= { pass: 0, fail: 0 }
  bySection[r.section][r.ok ? 'pass' : 'fail']++
}
console.log('\n## summary')
for (const [name, { pass, fail }] of Object.entries(bySection)) console.log(`  ${fail ? 'FAIL' : 'ok  '} ${name}: ${pass} passed${fail ? `, ${fail} failed` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (warnings.length) {
  console.log(`${warnings.length} upstream warning(s):`)
  for (const w of warnings) console.log(`  WARN ${w.section} › ${w.name}`)
}
process.exit(failed.length ? 1 : 0)
