// node --test relay-realtime/coalesce.test.mjs   (from infra/)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { coalesce, compareIds, docId } from './coalesce.mjs'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const at = new Date('2026-09-28T12:00:00Z')

let next = 1
const change = (op, rowId, { table = 'messages', account = A, keys, id } = {}) => ({
  id: String(id ?? next++),
  account_id: account,
  table_name: table,
  op,
  row_id: rowId,
  keys: keys ?? { id: rowId },
  created_at: at,
})

describe('coalesce', () => {
  it('passes single changes through, in id order', () => {
    const signals = coalesce([change('INSERT', 'm1'), change('UPDATE', 'c1', { table: 'conversations' })])
    assert.deepEqual(
      signals.map((s) => [s.table, s.op, s.rowId]),
      [
        ['messages', 'INSERT', 'm1'],
        ['conversations', 'UPDATE', 'c1'],
      ],
    )
  })

  it('folds repeated updates into one, keeping every id', () => {
    const rows = [change('UPDATE', 'm1'), change('UPDATE', 'm1'), change('UPDATE', 'm1')]
    const [signal, ...rest] = coalesce(rows)
    assert.equal(rest.length, 0)
    assert.equal(signal.op, 'UPDATE')
    assert.deepEqual(signal.ids, rows.map((r) => r.id))
    assert.equal(signal.seq, rows[2].id)
  })

  it('keeps INSERT when updates follow it', () => {
    const [signal] = coalesce([change('INSERT', 'm1'), change('UPDATE', 'm1')])
    assert.equal(signal.op, 'INSERT')
  })

  it('drops a row inserted and deleted in the same batch', () => {
    assert.deepEqual(coalesce([change('INSERT', 'm1'), change('UPDATE', 'm1'), change('DELETE', 'm1')]), [])
  })

  it('reports DELETE after updates, with the delete-time keys', () => {
    const rows = [
      change('UPDATE', 'r1', { table: 'message_reactions' }),
      change('DELETE', 'r1', { table: 'message_reactions', keys: { id: 'r1', conversation_id: 'c9' } }),
    ]
    const [signal] = coalesce(rows)
    assert.equal(signal.op, 'DELETE')
    assert.deepEqual(signal.keys, { id: 'r1', conversation_id: 'c9' })
  })

  it('treats a delete then re-insert of the same key as INSERT', () => {
    const [signal] = coalesce([
      change('DELETE', 'u1', { table: 'member_presence' }),
      change('INSERT', 'u1', { table: 'member_presence' }),
    ])
    assert.equal(signal.op, 'INSERT')
  })

  it('never merges across accounts or tables', () => {
    const signals = coalesce([
      change('UPDATE', 'x', { account: A }),
      change('UPDATE', 'x', { account: B }),
      change('UPDATE', 'x', { table: 'conversations' }),
    ])
    assert.equal(signals.length, 3)
  })

  it('orders by the last change of each row, numerically', () => {
    const signals = coalesce([
      change('UPDATE', 'm1', { id: 9 }),
      change('UPDATE', 'm2', { id: 10 }),
      change('UPDATE', 'm1', { id: 11 }),
    ])
    assert.deepEqual(
      signals.map((s) => s.rowId),
      ['m2', 'm1'],
    )
  })
})

describe('ids', () => {
  it('compares bigint strings numerically', () => {
    assert.ok(compareIds('9', '10') < 0)
    assert.ok(compareIds('100', '99') > 0)
    assert.equal(compareIds('42', '42'), 0)
  })

  it('pads document ids so they sort as numbers', () => {
    assert.equal(docId('42'), '0000000000000000042')
    assert.ok(docId('9') < docId('10'))
  })
})
