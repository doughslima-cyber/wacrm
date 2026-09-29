// Applies the schema to Cloud SQL, in this order:
//   1. infra/db/compat/*.sql     — Supabase stand-ins (roles, auth, storage)
//   2. supabase/migrations/*.sql — upstream migrations, never edited
//   3. infra/db/migrations/*.sql — our own additions (realtime notify, ...)
// then runs supabase/ci/verify-schema.sql and infra/db/verify-rpc-grants.sql.
//
// Each file runs in its own transaction and is recorded in
// supabase_migrations.schema_migrations, so re-running only applies
// what is new. Connects through the Cloud SQL connector (IAM + TLS),
// so the instance needs no authorized networks.
//
// Env:
//   INSTANCE_CONNECTION_NAME  project:region:instance
//   PGPASSWORD                password of the `postgres` user
//   DATABASE_URL              instead of the two above: a plain
//                             postgres:// URL (a superuser), for CI's
//                             throwaway database. The path is ignored;
//                             DB_NAME picks the database.
//   DB_NAME                   default: wacrm
//   AUTHENTICATOR_PASSWORD    optional; sets the PostgREST login password
//   RELAY_PASSWORD            optional; sets the realtime relay's login password
//   GOOGLE_OAUTH_ACCESS_TOKEN optional; e.g. $(gcloud auth print-access-token)
//                             on a workstation without Application Default
//                             Credentials. Without it, ADC is used (CI).
//
// Flags:
//   --verify-only   skip migrations, only run the schema assertions

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { Connector } from '@google-cloud/cloud-sql-connector'
import { OAuth2Client } from 'google-auth-library'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

const SOURCES = [
  path.join(here, 'compat'),
  path.join(repoRoot, 'supabase', 'migrations'),
  path.join(here, 'migrations'),
]
const VERIFY_FILES = [
  path.join(repoRoot, 'supabase', 'ci', 'verify-schema.sql'),
  path.join(here, 'verify-rpc-grants.sql'),
]

const directUrl = process.env.DATABASE_URL
const instance = directUrl ? null : required('INSTANCE_CONNECTION_NAME')
const password = directUrl ? null : required('PGPASSWORD')
const dbName = process.env.DB_NAME || 'wacrm'
const verifyOnly = process.argv.includes('--verify-only')

function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`missing env var ${name}`)
    process.exit(1)
  }
  return value
}

function connectorAuth() {
  const token = process.env.GOOGLE_OAUTH_ACCESS_TOKEN
  if (!token) return undefined
  const client = new OAuth2Client()
  client.setCredentials({ access_token: token })
  return client
}

const connector = directUrl ? null : new Connector({ auth: connectorAuth() })
const clientOpts = connector
  ? await connector.getOptions({ instanceConnectionName: instance, ipType: 'PUBLIC' })
  : null

function directConfig(database) {
  const url = new URL(directUrl)
  url.pathname = `/${database}`
  return { connectionString: url.toString() }
}

async function connect(database) {
  const client = new pg.Client(
    connector ? { ...clientOpts, user: 'postgres', password, database } : directConfig(database),
  )
  await client.connect()
  return client
}

async function ensureDatabase() {
  const admin = await connect('postgres')
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`)
      console.log(`created database ${dbName}`)
    }
  } finally {
    await admin.end()
  }
}

async function listSql(dir) {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => path.join(dir, f))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

async function migrate(db) {
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `)
  const { rows } = await db.query('SELECT version FROM supabase_migrations.schema_migrations')
  const applied = new Set(rows.map((r) => r.version))

  let count = 0
  for (const dir of SOURCES) {
    for (const file of await listSql(dir)) {
      const version = path.relative(repoRoot, file).replaceAll('\\', '/')
      if (applied.has(version)) continue
      const sql = await readFile(file, 'utf8')
      process.stdout.write(`applying ${version} ... `)
      try {
        await db.query('BEGIN')
        await db.query(sql)
        await db.query('INSERT INTO supabase_migrations.schema_migrations (version) VALUES ($1)', [version])
        await db.query('COMMIT')
        console.log('ok')
        count++
      } catch (err) {
        await db.query('ROLLBACK')
        console.log('FAILED')
        console.error(`\n${version}: ${err.message}`)
        if (err.position) console.error(`at character ${err.position}`)
        if (err.where) console.error(err.where)
        err.reported = true
        throw err
      }
    }
  }
  console.log(`${count} file(s) applied, ${applied.size} already present`)
}

async function setLoginPasswords(db) {
  for (const [role, envVar] of [
    ['authenticator', 'AUTHENTICATOR_PASSWORD'],
    ['realtime_relay', 'RELAY_PASSWORD'],
  ]) {
    const pw = process.env[envVar]
    if (!pw) continue
    await db.query(`ALTER ROLE ${pg.escapeIdentifier(role)} PASSWORD ${pg.escapeLiteral(pw)}`)
    console.log(`${role} password set`)
  }
}

async function verify(db) {
  for (const file of VERIFY_FILES) {
    await db.query(await readFile(file, 'utf8'))
    console.log(`${path.basename(file)} passed`)
  }
}

let db
try {
  await ensureDatabase()
  db = await connect(dbName)
  if (!verifyOnly) {
    await migrate(db)
    await setLoginPasswords(db)
  }
  await verify(db)
} catch (err) {
  if (!err.reported) console.error(err.message)
  process.exitCode = 1
} finally {
  await db?.end()
  connector?.close()
}
