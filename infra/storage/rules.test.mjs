// storage.rules against the Storage emulator.
//
//   cd infra && npm run storage:test-rules
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
import { deleteObject, getBytes, listAll, ref, uploadBytes } from 'firebase/storage'

const RULES = fileURLToPath(new URL('../../storage.rules', import.meta.url))
const BUCKET = 'demo-wacrm.firebasestorage.app'

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const MB = 1024 * 1024
const bytes = (n) => new Uint8Array(n)

let env

before(async () => {
  const [host, port] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199').split(':')
  env = await initializeTestEnvironment({
    projectId: 'demo-wacrm',
    storage: { host, port: Number(port), rules: readFileSync(RULES, 'utf8') },
  })
})

after(async () => {
  await env?.cleanup()
})

beforeEach(async () => {
  await env.clearStorage()
})

const alice = () =>
  env.authenticatedContext('firebase-a', { userId: USER_A, accountIds: [ACCOUNT_A] }).storage(`gs://${BUCKET}`)
const bob = () =>
  env.authenticatedContext('firebase-b', { userId: USER_B, accountIds: [ACCOUNT_B] }).storage(`gs://${BUCKET}`)
const noClaims = () => env.authenticatedContext('firebase-c').storage(`gs://${BUCKET}`)
const anonymous = () => env.unauthenticatedContext().storage(`gs://${BUCKET}`)

const put = (storage, path, size, contentType) => uploadBytes(ref(storage, path), bytes(size), { contentType })

describe('chat-media and flow-media', () => {
  for (const prefix of ['chat-media', 'flow-media']) {
    const own = `${prefix}/account-${ACCOUNT_A}/1770000000000-a.png`

    it(`${prefix}: a member writes, reads and deletes in their account folder`, async () => {
      await assertSucceeds(put(alice(), own, 10, 'image/png'))
      await assertSucceeds(put(alice(), `${prefix}/account-${ACCOUNT_A}/inbound/x.pdf`, 10, 'application/pdf'))
      await assertSucceeds(deleteObject(ref(alice(), own)))
    })

    it(`${prefix}: another account can't write or delete there`, async () => {
      await assertSucceeds(put(alice(), own, 10, 'image/png'))
      await assertFails(put(bob(), `${prefix}/account-${ACCOUNT_A}/b.png`, 10, 'image/png'))
      await assertFails(put(bob(), own, 10, 'image/png'))
      await assertFails(deleteObject(ref(bob(), own)))
    })

    it(`${prefix}: no claims or no sign-in means no writes`, async () => {
      await assertFails(put(noClaims(), own, 10, 'image/png'))
      await assertFails(put(anonymous(), own, 10, 'image/png'))
    })

    it(`${prefix}: the folder must be account-<uuid>`, async () => {
      await assertFails(put(alice(), `${prefix}/${ACCOUNT_A}/a.png`, 10, 'image/png'))
      await assertFails(put(alice(), `${prefix}/x-account-${ACCOUNT_A}/a.png`, 10, 'image/png'))
      await assertFails(put(alice(), `${prefix}/a.png`, 10, 'image/png'))
    })

    it(`${prefix}: size and type limits apply`, async () => {
      await assertSucceeds(put(alice(), `${prefix}/account-${ACCOUNT_A}/max.mp4`, 16 * MB, 'video/mp4'))
      await assertFails(put(alice(), `${prefix}/account-${ACCOUNT_A}/big.mp4`, 16 * MB + 1, 'video/mp4'))
      await assertFails(put(alice(), `${prefix}/account-${ACCOUNT_A}/x.exe`, 10, 'application/x-msdownload'))
      await assertFails(put(alice(), `${prefix}/account-${ACCOUNT_A}/x.html`, 10, 'text/html'))
    })

    it(`${prefix}: anyone can open an object by its URL, nobody can list`, async () => {
      await assertSucceeds(put(alice(), own, 10, 'image/png'))
      await assertSucceeds(getBytes(ref(anonymous(), own)))
      await assertSucceeds(getBytes(ref(bob(), own)))
      await assertFails(listAll(ref(anonymous(), `${prefix}/account-${ACCOUNT_A}`)))
      await assertFails(listAll(ref(alice(), `${prefix}/account-${ACCOUNT_A}`)))
    })
  }

  it('audio is chat-media only', async () => {
    await assertSucceeds(put(alice(), `chat-media/account-${ACCOUNT_A}/v.ogg`, 10, 'audio/ogg'))
    await assertFails(put(alice(), `flow-media/account-${ACCOUNT_A}/v.ogg`, 10, 'audio/ogg'))
  })
})

describe('avatars', () => {
  const own = `avatars/${USER_A}/avatar-1.png`

  it('a user writes, replaces and deletes their own avatar', async () => {
    await assertSucceeds(put(alice(), own, 10, 'image/png'))
    await assertSucceeds(put(alice(), own, 20, 'image/gif'))
    await assertSucceeds(deleteObject(ref(alice(), own)))
  })

  it("nobody else can touch it, not even the same account's members", async () => {
    const teammate = env
      .authenticatedContext('firebase-t', { userId: USER_B, accountIds: [ACCOUNT_A] })
      .storage(`gs://${BUCKET}`)
    await assertSucceeds(put(alice(), own, 10, 'image/png'))
    await assertFails(put(teammate, own, 10, 'image/png'))
    await assertFails(deleteObject(ref(teammate, own)))
    await assertFails(put(noClaims(), `avatars/${USER_A}/x.png`, 10, 'image/png'))
  })

  it('is limited to 2 MB images', async () => {
    await assertSucceeds(put(alice(), `avatars/${USER_A}/max.jpg`, 2 * MB, 'image/jpeg'))
    await assertFails(put(alice(), `avatars/${USER_A}/big.jpg`, 2 * MB + 1, 'image/jpeg'))
    await assertFails(put(alice(), `avatars/${USER_A}/a.pdf`, 10, 'application/pdf'))
  })

  it('is publicly readable', async () => {
    await assertSucceeds(put(alice(), own, 10, 'image/png'))
    await assertSucceeds(getBytes(ref(anonymous(), own)))
  })
})

describe('everything else', () => {
  it('is closed', async () => {
    await assertFails(put(alice(), 'secrets/a.txt', 10, 'text/plain'))
    await assertFails(put(alice(), `account-${ACCOUNT_A}/a.png`, 10, 'image/png'))
    await assertFails(getBytes(ref(anonymous(), 'secrets/a.txt')))
  })
})
