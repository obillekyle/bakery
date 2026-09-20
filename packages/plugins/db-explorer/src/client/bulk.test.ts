import { describe, expect, test } from 'bun:test'
import { restorableRow } from './bulk'

/**
 * The undo offered after deleting a single row.
 *
 * It re-inserts the row the grid rendered, and `getData` adds a key that is
 * not a column on two of the three dialects: SQLite selects `rowid`,
 * Postgres `ctid::text AS rowid`. `validateInsertRow` refuses unknown columns
 * by design, so the restore answered `400 rowid: unknown_column` and the undo
 * did nothing. MySQL selects `*` and never showed it, and the stub adapter in
 * the endpoint tests returns no rows at all, so nothing in the suite could
 * see it.
 */
describe('restoring a deleted row', () => {
  const columns = [{ name: 'id' }, { name: 'courier' }, { name: 'weight' }]

  test('drops the rowid the driver added', () => {
    const fromGrid = { rowid: 7, id: 3, courier: 'dhl', weight: 12 }
    expect(restorableRow(fromGrid, columns)).toEqual({
      id: 3,
      courier: 'dhl',
      weight: 12,
    })
  })

  test('keeps a null rather than dropping the column', () => {
    // `in`, not truthiness: a NULL column is still a column, and omitting it
    // would let the database substitute a default on restore.
    const fromGrid = { rowid: 1, id: 4, courier: null, weight: 0 }
    const row = restorableRow(fromGrid, columns)
    expect(row).toEqual({ id: 4, courier: null, weight: 0 })
    expect('courier' in row).toBe(true)
  })

  test('omits a column the row did not carry', () => {
    expect(restorableRow({ id: 5 }, columns)).toEqual({ id: 5 })
  })

  test('a MySQL row, which never had the extra key, is unchanged', () => {
    const fromGrid = { id: 6, courier: 'ups', weight: 3 }
    expect(restorableRow(fromGrid, columns)).toEqual(fromGrid)
  })
})
