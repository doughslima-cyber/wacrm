// firestore.rules against the Firestore emulator.
//
//   cd infra && npm run firestore:test-rules
//
// (firebase emulators:exec starts the emulator with the repo's
// firebase.json and runs this file; needs Java.)

import { after, before, beforeEach, describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  Timestamp,
  where,
} from 'firebase/firestore'

const RULES = fileURLToPath(new URL('../../firestore.rules', import.meta.url))

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SIGNAL = `signals/${ACCOUNT_A}/changes/0000000000000000001`

let env

before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':')
  env = await initializeTestEnvironment({
    projectId: 'demo-wacrm',
    firestore: { host, port: Number(port), rules: readFileSync(RULES, 'utf8') },
  })
})

after(async () => {
  await env?.cleanup()
})

beforeEach(async () => {
  await env.clearFirestore()
  // What the relay writes, bypassing the rules like the Admin SDK does.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), SIGNAL), {
      seq: 1,
      table: 'messages',
      op: 'INSERT',
      rowId: 'm1',
      keys: { id: 'm1', conversation_id: 'c1' },
      ids: [1],
      at: Timestamp.now(),
    })
  })
})

const alice = () => env.authenticatedContext('firebase-a', { accountIds: [ACCOUNT_A] }).firestore()
const bob = () => env.authenticatedContext('firebase-b', { accountIds: [ACCOUNT_B] }).firestore()
const twoAccounts = () =>
  env.authenticatedContext('firebase-c', { accountIds: [ACCOUNT_B, ACCOUNT_A] }).firestore()
const noClaims = () => env.authenticatedContext('firebase-d').firestore()
const stringClaim = () => env.authenticatedContext('firebase-e', { accountIds: ACCOUNT_A }).firestore()
const anonymous = () => env.unauthenticatedContext().firestore()

const changesOf = (db, account) => collection(db, 'signals', account, 'changes')
const recent = (db, account) => query(changesOf(db, account), where('at', '>', Timestamp.fromMillis(0)))

/** Resolves on the first snapshot, rejects on a listener error. */
const listen = (q) =>
  new Promise((resolve, reject) => {
    const stop = onSnapshot(
      q,
      (snap) => {
        stop()
        resolve(snap)
      },
      reject,
    )
  })

describe('signals', () => {
  it('a member reads and listens to their account', async () => {
    await assertSucceeds(getDoc(doc(alice(), SIGNAL)))
    const snap = await assertSucceeds(getDocs(recent(alice(), ACCOUNT_A)))
    if (snap.size !== 1) throw new Error(`expected 1 signal, got ${snap.size}`)
    await assertSucceeds(listen(recent(alice(), ACCOUNT_A)))
  })

  it('any account in the claim works', async () => {
    await assertSucceeds(getDocs(recent(twoAccounts(), ACCOUNT_A)))
  })

  it("another account can't read, list or listen", async () => {
    await assertFails(getDoc(doc(bob(), SIGNAL)))
    await assertFails(getDocs(recent(bob(), ACCOUNT_A)))
    await assertFails(listen(recent(bob(), ACCOUNT_A)))
  })

  it('no claim, a malformed claim or no sign-in reads nothing', async () => {
    await assertFails(getDocs(recent(noClaims(), ACCOUNT_A)))
    await assertFails(getDocs(recent(stringClaim(), ACCOUNT_A)))
    await assertFails(getDocs(recent(anonymous(), ACCOUNT_A)))
  })

  it('clients never write, not even to their own account', async () => {
    await assertFails(setDoc(doc(alice(), `signals/${ACCOUNT_A}/changes/x`), { op: 'DELETE' }))
    await assertFails(setDoc(doc(alice(), SIGNAL), { op: 'DELETE' }, { merge: true }))
    await assertFails(deleteDoc(doc(alice(), SIGNAL)))
    await assertFails(setDoc(doc(alice(), `signals/${ACCOUNT_A}`), { x: 1 }))
  })

  it('the rest of the database is closed', async () => {
    await assertFails(getDoc(doc(alice(), `signals/${ACCOUNT_A}`)))
    await assertFails(getDocs(collection(alice(), 'signals')))
    await assertFails(getDoc(doc(alice(), 'other/doc')))
    await assertFails(setDoc(doc(alice(), 'other/doc'), { x: 1 }))
  })
})
