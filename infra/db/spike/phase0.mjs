// Phase 0 gate: proves that the Supabase query builder the app uses
// (@supabase/postgrest-js, same version as the app) behaves the same
// against Cloud SQL + PostgREST, and that RLS still isolates accounts.
//
// Seeds two users (A and B) straight into auth.users, which fires the
// upstream on_auth_user_created trigger exactly as a Supabase signup
// would, then talks to the deployed PostgREST with JWTs minted the way
// the /api/rest proxy will mint them. Cleans up before and after.
//
// Env: INSTANCE_CONNECTION_NAME, PGPASSWORD, GOOGLE_OAUTH_ACCESS_TOKEN,
//      PGRST_URL, PGRST_ID_TOKEN (Google ID token, audience = PGRST_URL),
//      PGRST_JWT_SECRET

import { createHmac } from 'node:crypto'
import { PostgrestClient } from '@supabase/postgrest-js'
import { openDb } from './db.mjs'

const URL = process.env.PGRST_URL
const ID_TOKEN = process.env.PGRST_ID_TOKEN
const SECRET = process.env.PGRST_JWT_SECRET

// ------------------------------------------------------------------
// JWT + clients
// ------------------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64url')

function mintJwt(claims) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ aud: 'authenticated', iat: now, exp: now + 60, ...claims }))
  const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

function client(claims) {
  const headers = { 'X-Serverless-Authorization': `Bearer ${ID_TOKEN}` }
  if (claims) headers.Authorization = `Bearer ${mintJwt(claims)}`
  return new PostgrestClient(URL, { headers })
}

const asUser = (id) => client({ sub: id, role: 'authenticated' })
const asService = () => client({ role: 'service_role' })
const asAnon = () => client(null)

// ------------------------------------------------------------------
// Tiny test runner
// ------------------------------------------------------------------
const results = []
async function test(name, fn) {
  const t0 = performance.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: performance.now() - t0 })
  } catch (err) {
    results.push({ name, ok: false, ms: performance.now() - t0, err: err.message })
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function unwrap({ data, error, count }) {
  if (error) throw new Error(`${error.code}: ${error.message}`)
  return { data, count }
}

// ------------------------------------------------------------------
// Seed
// ------------------------------------------------------------------
const db = await openDb()
const q = (sql, params) => db.client.query(sql, params)

async function cleanup() {
  const { rows } = await q(`SELECT id FROM auth.users WHERE firebase_uid LIKE 'spike-%'`)
  const ids = rows.map((r) => r.id)
  if (!ids.length) return
  await q(`DELETE FROM public.accounts WHERE owner_user_id = ANY($1)`, [ids])
  await q(`DELETE FROM public.profiles WHERE user_id = ANY($1)`, [ids])
  await q(`DELETE FROM auth.users WHERE id = ANY($1)`, [ids])
}

async function seedUser(tag) {
  const { rows } = await q(
    `INSERT INTO auth.users (firebase_uid, email, raw_user_meta_data)
     VALUES ($1, $2, $3) RETURNING id`,
    [`spike-${tag}`, `${tag}@spike.test`, { full_name: `Spike ${tag.toUpperCase()}` }],
  )
  const userId = rows[0].id
  const p = await q(`SELECT account_id, id FROM public.profiles WHERE user_id = $1`, [userId])
  assert(p.rowCount === 1, `trigger did not create a profile for ${tag}`)
  return { userId, profileId: p.rows[0].id, accountId: p.rows[0].account_id }
}

async function seedData(u, tag) {
  const ins = async (sql, params) => (await q(sql, params)).rows[0].id
  const contactId = await ins(
    `INSERT INTO contacts (user_id, account_id, phone, name, email)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [u.userId, u.accountId, `+5511900000${tag === 'a' ? '01' : '02'}`, `Maria ${tag}`, `maria.${tag}@spike.test`],
  )
  await ins(
    `INSERT INTO contacts (user_id, account_id, phone, name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [u.userId, u.accountId, `+5511911111${tag === 'a' ? '01' : '02'}`, `João ${tag}`],
  )
  const pipelineId = await ins(
    `INSERT INTO pipelines (user_id, account_id, name) VALUES ($1, $2, 'Vendas') RETURNING id`,
    [u.userId, u.accountId],
  )
  const stageId = await ins(
    `INSERT INTO pipeline_stages (pipeline_id, name, position) VALUES ($1, 'Novo', 0) RETURNING id`,
    [pipelineId],
  )
  // deals.assigned_to may point at profiles.id or profiles.user_id —
  // read the FK instead of guessing.
  const fk = await q(`
    SELECT a.attname FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = c.confkey[1]
    WHERE c.conname = 'deals_assigned_to_fkey'`)
  const assignee = fk.rows[0].attname === 'user_id' ? u.userId : u.profileId
  await ins(
    `INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, contact_id, title, assigned_to)
     VALUES ($1, $2, $3, $4, $5, 'Deal spike', $6) RETURNING id`,
    [u.userId, u.accountId, pipelineId, stageId, contactId, assignee],
  )
  const tagId = await ins(
    `INSERT INTO tags (user_id, account_id, name) VALUES ($1, $2, 'vip') RETURNING id`,
    [u.userId, u.accountId],
  )
  await ins(`INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) RETURNING id`, [contactId, tagId])

  const docId = await ins(
    `INSERT INTO ai_knowledge_documents (account_id, created_by, title, content)
     VALUES ($1, $2, 'Horários', 'Atendemos de segunda a sexta') RETURNING id`,
    [u.accountId, u.userId],
  )
  const dims = await q(`
    SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
    WHERE attrelid = 'public.ai_knowledge_chunks'::regclass AND attname = 'embedding'`)
  const n = Number(/\((\d+)\)/.exec(dims.rows[0].t)?.[1] ?? 1536)
  const embedding = `[${Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`
  await ins(
    `INSERT INTO ai_knowledge_chunks (document_id, account_id, chunk_index, content, embedding)
     VALUES ($1, $2, 0, 'Atendemos de segunda a sexta, das 9h às 18h', $3::vector) RETURNING id`,
    [docId, u.accountId, embedding],
  )
  return { contactId, pipelineId, tagId, embedding }
}

await cleanup()
const A = await seedUser('a')
const B = await seedUser('b')
const dA = await seedData(A, 'a')
const dB = await seedData(B, 'b')

// ------------------------------------------------------------------
// RLS
// ------------------------------------------------------------------
await test('RLS: A lê só os contatos da conta A', async () => {
  const { data } = unwrap(await asUser(A.userId).from('contacts').select('id, account_id'))
  assert(data.length === 2, `esperava 2 contatos, veio ${data.length}`)
  assert(data.every((r) => r.account_id === A.accountId), 'veio contato de outra conta')
})

await test('RLS: A não consegue inserir contato na conta B', async () => {
  const { error } = await asUser(A.userId)
    .from('contacts')
    .insert({ user_id: A.userId, account_id: B.accountId, phone: '+5511999999999', name: 'intruso' })
  assert(error, 'insert na conta B foi aceito')
  assert(error.code === '42501', `erro inesperado: ${error.code} ${error.message}`)
})

await test('RLS: A não consegue alterar contato da conta B', async () => {
  const { data } = unwrap(
    await asUser(A.userId).from('contacts').update({ name: 'hackeado' }).eq('id', dB.contactId).select('id'),
  )
  assert(data.length === 0, 'update na conta B afetou linhas')
  const check = await q(`SELECT name FROM contacts WHERE id = $1`, [dB.contactId])
  assert(check.rows[0].name === 'Maria b', 'o nome do contato de B mudou')
})

await test('RLS: anon não lê nada', async () => {
  const { data } = unwrap(await asAnon().from('contacts').select('id'))
  assert(data.length === 0, `anon leu ${data.length} contatos`)
})

await test('RLS: service_role lê as duas contas (BYPASSRLS)', async () => {
  const { data } = unwrap(
    await asService().from('contacts').select('id').in('account_id', [A.accountId, B.accountId]),
  )
  assert(data.length === 4, `esperava 4, veio ${data.length}`)
})

await test('RLS: JWT com assinatura errada é rejeitado', async () => {
  const forged = mintJwt({ sub: A.userId, role: 'service_role' }).replace(/.$/, 'x')
  const c = new PostgrestClient(URL, {
    headers: { 'X-Serverless-Authorization': `Bearer ${ID_TOKEN}`, Authorization: `Bearer ${forged}` },
  })
  const { error } = await c.from('contacts').select('id')
  assert(error && error.code?.startsWith('PGRST30'), `esperava PGRST30x, veio ${error?.code ?? 'sucesso'}`)
})

// ------------------------------------------------------------------
// Paridade com queries reais do app
// ------------------------------------------------------------------
await test('Paridade: join embutido com hint de FK (pipelines/page.tsx:104)', async () => {
  const { data } = unwrap(
    await asUser(A.userId)
      .from('deals')
      .select('*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)'),
  )
  assert(data.length === 1, `esperava 1 deal, veio ${data.length}`)
  assert(data[0].contact?.name === 'Maria a', 'contact embutido veio errado')
  assert(data[0].assignee?.email === 'a@spike.test', 'assignee embutido veio errado')
})

await test("Paridade: count 'exact' + .or() com ilike (contacts/page.tsx:159)", async () => {
  const like = '%maria%'
  const { data, count } = unwrap(
    await asUser(A.userId)
      .from('contacts')
      .select('*', { count: 'exact' })
      .or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`),
  )
  assert(count === 1 && data.length === 1, `count=${count} len=${data.length}`)
})

await test("Paridade: count 'exact' com head: true (step2-select-audience.tsx:210)", async () => {
  const { data, count } = unwrap(
    await asUser(A.userId).from('contacts').select('*', { count: 'exact', head: true }),
  )
  assert(count === 2 && data === null, `count=${count} data=${JSON.stringify(data)}`)
})

await test('Paridade: embed !inner filtrado (padrão do webhook/route.ts:549)', async () => {
  const { data } = unwrap(
    await asService()
      .from('deals')
      .select('id, pipelines!inner(account_id)')
      .eq('pipelines.account_id', A.accountId),
  )
  assert(data.length === 1, `esperava 1, veio ${data.length}`)
})

await test('Paridade: RPC SECURITY DEFINER filter_contacts_by_tags', async () => {
  const { data } = unwrap(
    await asUser(A.userId).rpc('filter_contacts_by_tags', {
      p_tag_ids: [dA.tagId],
      p_search: null,
      p_limit: 50,
      p_offset: 0,
    }),
  )
  const rows = Array.isArray(data) ? data : [data]
  assert(rows.length >= 1, 'não retornou o contato com a tag')
  // B passing A's tag id must not see A's contacts.
  const leak = unwrap(
    await asUser(B.userId).rpc('filter_contacts_by_tags', {
      p_tag_ids: [dA.tagId],
      p_search: null,
      p_limit: 50,
      p_offset: 0,
    }),
  ).data
  const leakRows = (Array.isArray(leak) ? leak : [leak]).filter(Boolean)
  const leaked = JSON.stringify(leakRows).includes(dA.contactId)
  assert(!leaked, 'B enxergou contato de A pela RPC')
})

await test('Paridade: RPC match_ai_knowledge_fts (full-text)', async () => {
  const { data } = unwrap(
    await asUser(A.userId).rpc('match_ai_knowledge_fts', {
      p_account_id: A.accountId,
      p_query: 'segunda sexta',
      p_match_count: 5,
    }),
  )
  assert(data.length === 1, `esperava 1 chunk, veio ${data.length}`)
})

await test('Paridade: RPC match_ai_knowledge_semantic (pgvector)', async () => {
  const { data } = unwrap(
    await asUser(A.userId).rpc('match_ai_knowledge_semantic', {
      p_account_id: A.accountId,
      p_query_embedding: dA.embedding,
      p_match_count: 5,
    }),
  )
  assert(data.length === 1, `esperava 1 chunk, veio ${data.length}`)
})

await test('RLS: B não lê a base de conhecimento de A pela RPC', async () => {
  const { data, error } = await asUser(B.userId).rpc('match_ai_knowledge_fts', {
    p_account_id: A.accountId,
    p_query: 'segunda sexta',
    p_match_count: 5,
  })
  assert(error || data.length === 0, `B leu ${data?.length} chunks de A`)
})

// ------------------------------------------------------------------
// Latência (quente)
// ------------------------------------------------------------------
const samples = []
for (let i = 0; i < 10; i++) {
  const t0 = performance.now()
  unwrap(await asUser(A.userId).from('contacts').select('id').limit(1))
  samples.push(performance.now() - t0)
}
samples.sort((a, b) => a - b)

await cleanup()
await db.close()

// ------------------------------------------------------------------
// Report
// ------------------------------------------------------------------
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms.toFixed(0)} ms)${r.ok ? '' : `\n      ${r.err}`}`)
}
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passaram`)
console.log(
  `latência do PostgREST a partir desta máquina: p50 ${samples[4].toFixed(0)} ms, p90 ${samples[8].toFixed(0)} ms`,
)
process.exitCode = failed ? 1 : 0
