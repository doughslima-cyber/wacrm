// Folds a batch of app_realtime.changes rows into the signals the
// relay writes to Firestore: one per changed row, in the order of each
// row's last change.
//
// A browser that receives a signal fetches the row as it is *now*, so
// three status updates on one message in the same batch are one
// UPDATE, an INSERT followed by UPDATEs is one INSERT, and a row
// inserted and deleted within the batch needs no signal at all.
//
// `ids` lists every change folded into a signal, so the browser can
// tell them apart from what its polling fallback reads straight from
// the log.

/**
 * @param {Array<{ id: string|number, account_id: string, table_name: string,
 *                 op: 'INSERT'|'UPDATE'|'DELETE', row_id: string,
 *                 keys: Record<string, unknown>, created_at: Date }>} rows
 *        ordered by id
 */
export function coalesce(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.account_id}\u0000${row.table_name}\u0000${row.row_id}`
    const group = groups.get(key)
    if (group) {
      group.last = row
      group.ids.push(String(row.id))
    } else {
      groups.set(key, { firstOp: row.op, last: row, ids: [String(row.id)] })
    }
  }

  const signals = []
  for (const { firstOp, last, ids } of groups.values()) {
    let op
    if (last.op === 'DELETE') {
      if (firstOp === 'INSERT') continue
      op = 'DELETE'
    } else {
      op = firstOp === 'INSERT' || last.op === 'INSERT' ? 'INSERT' : 'UPDATE'
    }
    signals.push({
      seq: String(last.id),
      accountId: last.account_id,
      table: last.table_name,
      op,
      rowId: last.row_id,
      keys: last.keys,
      createdAt: last.created_at,
      ids,
    })
  }
  return signals.sort((a, b) => compareIds(a.seq, b.seq))
}

/** bigint ids arrive from pg as strings; compare them as numbers. */
export function compareIds(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

/** Firestore document id for a signal: zero-padded so the console and
 *  the default __name__ tie-break list them in change order. */
export function docId(seq) {
  return String(seq).padStart(19, '0')
}
