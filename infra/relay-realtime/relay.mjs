// relay-realtime: app_realtime.changes (Cloud SQL) → Firestore signals.
//
// docs/firebase-migration.md §3.4, phase 4. Migration 045 appends a row
// to app_realtime.changes for every change the UI listens to and sends
// NOTIFY app_realtime at commit. This process:
//
//   1. LISTENs on app_realtime and, on each wake-up (and every
//      SAFETY_POLL_MS regardless), drains the unpublished rows in id
//      order, FOR UPDATE SKIP LOCKED;
//   2. folds them per row (coalesce.mjs) and writes one document per
//      signal to signals/{account_id}/changes/{seq}, ids and keys only;
//   3. marks the rows published in the same transaction, so a crash
//      between the Firestore write and the COMMIT only repeats writes
//      (same document ids), never skips them.
//
// Rows older than STALE_MS when they're first seen (the relay was down)
// are marked published without a signal: browsers polled them in the
// meantime, and a burst of old events would only confuse fresh tabs.
// Published rows older than RETAIN_MS are deleted.
//
// Runs as a Cloud Run service with one always-on instance (deploy.sh).
// The HTTP endpoint only exists for Cloud Run: it reports whether the
// database connection is up.
//
// Env:
//   INSTANCE_CONNECTION_NAME  project:region:instance
//   DB_NAME                   default: wacrm
//   DB_USER                   default: realtime_relay
//   DB_PASSWORD               the realtime_relay password (Secret Manager)
//   FIRESTORE_PROJECT         default: GOOGLE_CLOUD_PROJECT
//   GOOGLE_OAUTH_ACCESS_TOKEN optional, local runs without ADC
//   PORT                      default: 8080

import http from 'node:http'
import pg from 'pg'
import { Connector } from '@google-cloud/cloud-sql-connector'
import { FieldValue, Firestore, Timestamp } from '@google-cloud/firestore'
import { OAuth2Client } from 'google-auth-library'

import { coalesce, docId } from './coalesce.mjs'

const CHANNEL = 'app_realtime'
const BATCH = 500
const SAFETY_POLL_MS = 10_000
const CLEANUP_MS = 5 * 60_000
const STALE_MS = 10 * 60_000
const RETAIN_MS = 60 * 60_000
/** Firestore TTL (`expireAt`, set up in deploy.sh) removes signals after this. */
const SIGNAL_TTL_MS = 60 * 60_000
const MAX_BACKOFF_MS = 30_000

// ------------------------------------------------------------------
// Logging: one JSON line per event, which Cloud Logging parses.
// ------------------------------------------------------------------

function log(severity, message, fields = {}) {
  console.log(JSON.stringify({ severity, message, ...fields }))
}

function required(name) {
  const value = process.env[name]
  if (!value) {
    log('ERROR', `missing env var ${name}`)
    process.exit(1)
  }
  return value
}

// ------------------------------------------------------------------
// Clients
// ------------------------------------------------------------------

const instance = required('INSTANCE_CONNECTION_NAME')
const dbPassword = required('DB_PASSWORD')
const dbName = process.env.DB_NAME || 'wacrm'
const dbUser = process.env.DB_USER || 'realtime_relay'

function tokenAuth() {
  const token = process.env.GOOGLE_OAUTH_ACCESS_TOKEN
  if (!token) return undefined
  const client = new OAuth2Client()
  client.setCredentials({ access_token: token })
  return client
}

const authClient = tokenAuth()
const connector = new Connector({ auth: authClient })
const firestore = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || instance.split(':')[0],
  preferRest: true,
  ...(authClient ? { authClient } : {}),
})

// ------------------------------------------------------------------
// Publishing
// ------------------------------------------------------------------

async function publish(signals) {
  const expireAt = Timestamp.fromMillis(Date.now() + SIGNAL_TTL_MS)
  for (let i = 0; i < signals.length; i += BATCH) {
    const batch = firestore.batch()
    for (const s of signals.slice(i, i + BATCH)) {
      batch.set(firestore.doc(`signals/${s.accountId}/changes/${docId(s.seq)}`), {
        seq: Number(s.seq),
        table: s.table,
        op: s.op,
        rowId: s.rowId,
        keys: s.keys,
        ids: s.ids.map(Number),
        createdAt: Timestamp.fromDate(s.createdAt),
        at: FieldValue.serverTimestamp(),
        expireAt,
      })
    }
    await batch.commit()
  }
}

/** Publishes unpublished rows until the queue is empty. */
async function drain(db) {
  for (;;) {
    await db.query('BEGIN')
    let rows
    try {
      ;({ rows } = await db.query(
        `SELECT id, account_id, table_name, op, row_id, keys, created_at,
                created_at < now() - make_interval(secs => $2) AS stale
         FROM app_realtime.changes
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [BATCH, STALE_MS / 1000],
      ))
      if (rows.length === 0) {
        await db.query('COMMIT')
        return
      }
      const fresh = rows.filter((r) => !r.stale)
      const signals = coalesce(fresh)
      await publish(signals)
      await db.query('UPDATE app_realtime.changes SET published_at = now() WHERE id = ANY($1::bigint[])', [
        rows.map((r) => r.id),
      ])
      await db.query('COMMIT')
      stats.published += signals.length
      stats.lastPublishAt = new Date().toISOString()
      if (rows.length > fresh.length) log('WARNING', 'skipped stale changes', { count: rows.length - fresh.length })
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {})
      throw err
    }
    if (rows.length < BATCH) return
  }
}

async function cleanup(db) {
  const { rowCount } = await db.query(
    `DELETE FROM app_realtime.changes
     WHERE published_at IS NOT NULL AND created_at < now() - make_interval(secs => $1)`,
    [RETAIN_MS / 1000],
  )
  if (rowCount) log('INFO', 'deleted published changes', { count: rowCount })
}

// ------------------------------------------------------------------
// Connection loop
// ------------------------------------------------------------------

const stats = { connected: false, since: null, published: 0, lastPublishAt: null, lastError: null }

let db = null
let working = false
let drainWanted = false
let cleanupWanted = false
let stopping = false

/** Runs drain/cleanup one at a time on the single connection. */
async function work() {
  if (working || !db) return
  working = true
  const conn = db
  try {
    while (conn === db && (drainWanted || cleanupWanted)) {
      if (drainWanted) {
        drainWanted = false
        await drain(conn)
      } else {
        cleanupWanted = false
        await cleanup(conn)
      }
    }
  } catch (err) {
    stats.lastError = err.message
    log('ERROR', 'relay work failed', { error: err.message })
    // A database error ends the connection's usefulness; a Firestore
    // one is retried on the next wake-up or safety poll.
    if (conn === db && isConnectionError(err)) conn.end().catch(() => {})
  } finally {
    working = false
  }
}

function isConnectionError(err) {
  return !err.code || /^(08|57P)/.test(err.code)
}

function wake() {
  drainWanted = true
  void work()
}

async function connect() {
  const opts = await connector.getOptions({ instanceConnectionName: instance, ipType: 'PUBLIC' })
  const client = new pg.Client({
    ...opts,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    keepAlive: true,
    application_name: 'relay-realtime',
  })
  await client.connect()
  await client.query(`LISTEN ${CHANNEL}`)
  return client
}

async function run() {
  let backoff = 1000
  while (!stopping) {
    try {
      const client = await connect()
      db = client
      stats.connected = true
      stats.since = new Date().toISOString()
      backoff = 1000
      log('INFO', 'listening', { channel: CHANNEL })

      const closed = new Promise((resolve) => {
        client.on('error', (err) => {
          stats.lastError = err.message
          log('ERROR', 'database connection error', { error: err.message })
          resolve()
        })
        client.on('end', resolve)
      })
      client.on('notification', wake)

      // Whatever piled up while disconnected.
      wake()
      await closed
    } catch (err) {
      stats.lastError = err.message
      log('ERROR', 'could not connect', { error: err.message })
    }
    db = null
    stats.connected = false
    if (stopping) break
    const delay = Math.min(backoff, MAX_BACKOFF_MS) * (0.75 + Math.random() / 2)
    backoff *= 2
    await new Promise((r) => setTimeout(r, delay))
  }
}

setInterval(wake, SAFETY_POLL_MS).unref()
setInterval(() => {
  cleanupWanted = true
  void work()
}, CLEANUP_MS).unref()

// ------------------------------------------------------------------
// HTTP (Cloud Run needs a listening port)
// ------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const body = JSON.stringify(stats)
  res.writeHead(stats.connected ? 200 : 503, { 'content-type': 'application/json' })
  res.end(body)
})
server.listen(Number(process.env.PORT) || 8080)

async function shutdown() {
  stopping = true
  server.close()
  await db?.end().catch(() => {})
  connector.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

void run()
