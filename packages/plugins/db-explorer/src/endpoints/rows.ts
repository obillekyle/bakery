/**
 * The row write surface: insert, edit one, edit many, delete.
 *
 * **Every statement carries an explicit identity predicate**, built from the
 * key the caller sent and checked against the table's declared identity first.
 * The adapter's `update(table, rowid, row)` / `remove(table, rowid)` triple is
 * never used — see the header of `identity.ts` for the three ways it is wrong.
 *
 * **Optimistic concurrency** is the same predicate with `expect` appended:
 * identity ∧ expect. `changes === 0` therefore means one of two things, and the
 * dialects will not tell them apart — *the row moved on* or *the update was a
 * no-op*. MySQL reports 0 changed rows when an UPDATE sets a column to the
 * value it already held, so a zero has to be probed rather than trusted, and
 * the probe runs inside the same transaction as the UPDATE or it is answering
 * about a different moment.
 */

import { Try } from '@bakery-framework/core/utils'
import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import { getActiveDb } from '@bakery-framework/orm/connection'
import { DB } from '@bakery-framework/orm/orm'
import { qId } from '@bakery-framework/orm/schema-util'
import type { TableFacts } from '../identity'
import { overLimit } from '../policy'
import { conflictRollback, isRollbackSignal, previewRollback } from '../preview'
import {
  type FieldError,
  isRecord,
  unguardableColumns,
  validateInsertRow,
  validateKey,
  validatePartial,
} from '../validate'
import { beginWrite, type Envelope, invalid, refuse } from './common'

/**
 * A conflict, as the caller sees it: which edit, which row, and what the row
 * looks like now so the client can offer a diff rather than "try again".
 */
export interface Conflict {
  index: number
  key: Record<string, unknown>
  reason: string
  row: Record<string, unknown> | null
}

/**
 * One row by its identity, read through the active connection — which inside
 * `DB.transaction` is the transaction's own handle, not the pooled one.
 *
 * Built with `qId` and bound parameters (convention 8). `IS NULL` rather than
 * `= ?` for a null, because `NULL = NULL` is unknown and the predicate would
 * match nothing.
 */
async function selectRow(
  table: TableFacts,
  predicate: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const columns = Object.keys(predicate)
  if (!columns.length) return null

  const params: unknown[] = []
  const where = columns
    .map(column => {
      const value = predicate[column]
      if (value === null) return `${qId(column)} IS NULL`
      params.push(value)
      return `${qId(column)} = ?`
    })
    .join(' AND ')

  const row = await getActiveDb()
    .query(`SELECT * FROM ${qId(table.name)} WHERE ${where} LIMIT 1`)
    .get(...params)
  return (row as Record<string, unknown> | undefined) ?? null
}

/**
 * `where(a).and(b).and(c)…` over a predicate of any width.
 *
 * `any` for the value, because the builder's `WhereValue` is a union that also
 * carries column references and subqueries — narrowing to it here would mean
 * asserting a coerced database value is not one of those, which is true but
 * unprovable at this end. The values themselves are already bound parameters.
 */
function chain<E extends { and(column: any, value?: any): E }>(
  begin: (column: string, value: any) => E,
  predicate: Record<string, any>,
): E {
  const entries = Object.entries(predicate)
  const [first, rest] = [entries[0]!, entries.slice(1)]
  let executable = begin(first[0], first[1])
  for (const [column, value] of rest) executable = executable.and(column, value)
  return executable
}

/**
 * Turn a `RollbackSignal` back into a response, and rethrow anything else.
 *
 * The rethrow is the load-bearing half. A `catch` that answered 200 for every
 * throw would report a failed write as a successful dry run — see `preview.ts`.
 */
function fromRollback(error: any): Envelope {
  if (isRollbackSignal(error)) {
    return error.status >= 400
      ? response.json.error(error.status, error.message, error.report)
      : response.json.success(error.message, error.report, error.status)
  }
  // A rollback signal carries a message this plugin wrote, so it is safe to
  // pass on. Anything else reaching here is the driver's, and the driver's
  // text is not the caller's business — see `refuse`.
  return refuse('write', error)
}

// ---------------------------------------------------------------- POST /rows

export async function handleInsertRows(
  req: Request,
): Promise<JsonResponseData<unknown>> {
  const start = await beginWrite(req)
  if (!start.ok) return start.response
  const { table, body } = start

  const rows = body.rows
  if (!Array.isArray(rows) || !rows.length) {
    return response.json.error(400, 'rows must be a non-empty array')
  }

  // Before validation and before any statement: a 413 has to be true when it
  // says nothing was executed, and validating 100,000 rows to then refuse them
  // is work done on behalf of a request that was never going to run.
  const over = overLimit('insertRows', rows.length)
  if (over) return response.json.error(413, over)

  const errors: FieldError[] = []
  const records: Record<string, unknown>[] = []
  rows.forEach((row, index) => {
    const validated = validateInsertRow(row, table, index)
    errors.push(...validated.errors)
    records.push(validated.values)
  })
  if (errors.length) return invalid(errors)

  const returning = body.returning === true

  return await Try.return(
    async () => {
      // `DB.Insert` already batches under the adapter's parameter ceiling and
      // wraps multiple batches in one transaction, so there is nothing to add
      // here — which is exactly why the insert goes through it rather than
      // through the adapter's own `insert()`.
      const insert = DB.Insert.into(table.name).values(records)
      if (!returning) {
        const result = await insert.run()
        return response.json.success('inserted', {
          inserted: Number(result.changes ?? 0),
        })
      }
      // `RETURNING` is SQLite and Postgres only — MySQL has no such clause and
      // answers with its own syntax error, which is loud and correct. It is not
      // emulated: a re-SELECT would have to guess the generated keys, and
      // guessing which rows were just written is the class of bug this whole
      // module exists to avoid.
      const written = await insert
        .returning('*')
        .array<Record<string, unknown>>()
      return response.json.success('inserted', {
        inserted: written.length,
        rows: written,
      })
    },
    error => refuse('insert', error),
  )
}

// --------------------------------------------------------------- PATCH /row

export async function handleUpdateRow(
  req: Request,
): Promise<JsonResponseData<unknown>> {
  const start = await beginWrite(req)
  if (!start.ok) return start.response
  const { table, body } = start

  if (!isRecord(body.expect)) {
    // Required, not optional. An update with no `expect` is a last-write-wins
    // update, and making that the default is how two people editing the same
    // row silently lose one of the two edits. `{}` is the explicit spelling of
    // "I accept that".
    return response.json.error(
      400,
      'expect is required — send {} to update without a concurrency check',
    )
  }

  const key = validateKey(body.key, table, 0)
  const set = validatePartial(body.set, table, 0, {
    allowUncomparable: true,
    label: 'set',
  })
  const expect = validatePartial(body.expect, table, 0, {
    allowUncomparable: false,
    label: 'expect',
  })

  const errors = [...key.errors, ...set.errors, ...expect.errors]
  if (errors.length) return invalid(errors)
  if (!Object.keys(set.values).length) {
    return response.json.error(400, 'set names no columns')
  }

  const unguardable = unguardableColumns(set.values, table)
  if (unguardable.length && body.force !== true) {
    return response.json.error(
      400,
      `${unguardable.join(', ')} cannot be guarded by expect; ` +
        'pass force: true to overwrite without a concurrency check',
    )
  }

  return await Try.return(
    async () =>
      await DB.transaction(async () => {
        const predicate = { ...key.where, ...expect.values }
        const result = await chain(
          (column, value) =>
            DB.Update.table(table.name).set(set.values).where(column, value),
          predicate,
        ).run()

        const changed = Number(result.changes ?? 0)
        if (changed > 0) {
          return response.json.success('updated', {
            changed,
            row: await selectRow(table, key.where),
          })
        }

        // Zero. Probe, in this transaction, before calling it a conflict:
        // MySQL reports zero changed rows for an UPDATE that set every column
        // to the value it already held, which is a successful no-op and not a
        // lost update. If the row still satisfies identity ∧ expect, that is
        // what happened.
        const unchanged = await selectRow(table, predicate)
        if (unchanged) {
          return response.json.success('unchanged', {
            changed: 0,
            row: unchanged,
          })
        }

        return response.json.error(409, 'The row changed since it was read', {
          changed: 0,
          row: await selectRow(table, key.where),
        })
      }),
    fromRollback,
  )
}

type PreparedEdit = {
  key: Record<string, unknown>
  set: Record<string, unknown>
  expect: Record<string, unknown>
}

type CollapsedGroup = {
  /** The one identity column every member addresses. */
  column: string
  set: Record<string, unknown>
  expect: Record<string, unknown>
  /**
   * The original edit index alongside its key value, so a conflict still names
   * the edit the caller sent rather than a position in a regrouped list.
   */
  members: { index: number; value: unknown }[]
}

/**
 * Split a bulk edit into runs that can share one statement and those that
 * cannot.
 *
 * A bulk edit issued one `UPDATE` per row, so 1,000 edits were 1,000
 * statements plus the transaction and the conflict probes on top. The rows
 * almost always share their `set` and their `expect` - that is what makes it a
 * *bulk* edit, one action applied to a selection - so grouping on those two
 * plus the identity column collapses the common case to one statement per
 * group.
 *
 * Three things disqualify a member, and each falls back rather than failing:
 *
 *   - a composite identity, because `IN` addresses one column;
 *   - a `null` key value, because `IN` never matches NULL and `IS NULL` is a
 *     different clause. The single-row `where` already handles it correctly,
 *     so falling back is not a compromise;
 *   - being alone in its group, where one statement is one statement either
 *     way and the collapsed path would only add a probe.
 *
 * Exported as a test seam (convention 9). Two of the three disqualifications -
 * a composite identity and a `null` key value - are hard to reach through the
 * endpoint, because a NOT NULL primary key cannot carry a null and validation
 * refuses it before this runs. The guard still earns its place: identity can
 * be a unique index over a nullable column, and `IN` would silently match
 * nothing there. Asserting it directly is the only honest way to pin it.
 */
export function groupBulkEdits(prepared: (PreparedEdit | null)[]): {
  collapsible: CollapsedGroup[]
  single: number[]
} {
  const groups = new Map<string, CollapsedGroup>()
  const single: number[] = []

  for (let index = 0; index < prepared.length; index++) {
    const edit = prepared[index]!
    const columns = Object.keys(edit.key)
    const column = columns[0]
    const value = column === undefined ? undefined : edit.key[column]

    if (columns.length !== 1 || column === undefined || value === null) {
      single.push(index)
      continue
    }

    const signature = JSON.stringify([column, edit.set, edit.expect])
    const group = groups.get(signature)
    if (group) {
      group.members.push({ index, value })
    } else {
      groups.set(signature, {
        column,
        set: edit.set,
        expect: edit.expect,
        members: [{ index, value }],
      })
    }
  }

  const collapsible: CollapsedGroup[] = []
  for (const group of groups.values()) {
    if (group.members.length > 1) collapsible.push(group)
    else single.push(group.members[0]!.index)
  }
  // The leftovers came out of a Map and have lost their order; they are
  // applied in sequence below, so put them back in the order they were sent.
  single.sort((a, b) => a - b)

  return { collapsible, single }
}

/**
 * Apply one collapsed group, and report any member that cannot be applied.
 *
 * **The probe runs before the write, not after it**, and that ordering is the
 * whole design. A collapsed `UPDATE` reports a row count, not identities, so a
 * short count says *some* member did not match without saying which. Finding
 * out afterwards is not possible: the update has already changed the columns
 * `expect` refers to, and re-running the members one at a time inside the same
 * transaction would apply them twice.
 *
 * So: ask which keys satisfy identity AND expect, treat the rest as conflicts,
 * and update only when there are none. That answers the MySQL no-op case for
 * free - a row that matches the probe but reports zero changed rows is a
 * no-op, decided exactly as the single-row path decides it, and the probe has
 * already established the row is there.
 *
 * Any conflict rolls the entire bulk edit back, so a group that has one skips
 * its update rather than writing something about to be discarded.
 */
async function applyCollapsedGroup(
  table: TableFacts,
  group: CollapsedGroup,
  conflicts: Conflict[],
): Promise<number> {
  let changed = 0

  // One bound parameter per key, plus the `set` and `expect` values, has to
  // fit inside the dialect's statement limit. `maxQueryParams` is the
  // adapter's own number; SQLite's 32,766 is the smallest of the three.
  const fixed = Object.keys(group.set).length + Object.keys(group.expect).length
  const limit = Math.max(1, getActiveDb().maxQueryParams - fixed - 1)

  for (let start = 0; start < group.members.length; start += limit) {
    const chunk = group.members.slice(start, start + limit)

    const matched = await selectKeyValues(
      table,
      group.column,
      chunk.map(m => m.value),
      group.expect,
    )

    const missing = chunk.filter(m => !matched.has(m.value))
    if (missing.length) {
      for (const member of missing) {
        const key = { [group.column]: member.value }
        conflicts.push({
          index: member.index,
          key,
          reason: 'the row changed since it was read',
          row: await selectRow(table, key),
        })
      }
      continue
    }

    let statement = DB.Update.table(table.name)
      .set(group.set)
      .where(group.column, DB.inList(chunk.map(m => m.value)))
    for (const [column, value] of Object.entries(group.expect)) {
      // `expect` has already been through `validatePartial`, which is what
      // decides a value is comparable at all; the builder's parameter type is
      // narrower than "whatever survived that" and the cast says so once here
      // rather than loosening the validator.
      statement = statement.and(column, value as never)
    }

    const result = await statement.run()
    changed += Number(result.changes ?? 0)
  }

  return changed
}

/**
 * Which of `values` name a row that also satisfies `expect`.
 *
 * A Set of the key values seen, so a key matching more than one row counts
 * once: the question is whether the edit addresses anything, not how much.
 */
async function selectKeyValues(
  table: TableFacts,
  column: string,
  values: unknown[],
  expect: Record<string, unknown>,
): Promise<Set<unknown>> {
  const params: unknown[] = [...values]
  const clauses = [`${qId(column)} IN (${values.map(() => '?').join(', ')})`]

  for (const [name, value] of Object.entries(expect)) {
    if (value === null) {
      clauses.push(`${qId(name)} IS NULL`)
    } else {
      params.push(value)
      clauses.push(`${qId(name)} = ?`)
    }
  }

  const rows = (await getActiveDb()
    .query(
      `SELECT ${qId(column)} FROM ${qId(table.name)} WHERE ${clauses.join(' AND ')}`,
    )
    .all(...params)) as Record<string, unknown>[]

  return new Set(rows.map(row => row[column]))
}

// ---------------------------------------------------------- POST /rows/bulk

export async function handleBulkEdit(
  req: Request,
): Promise<JsonResponseData<unknown>> {
  const start = await beginWrite(req)
  if (!start.ok) return start.response
  const { table, body } = start

  const edits = body.edits
  if (!Array.isArray(edits) || !edits.length) {
    return response.json.error(400, 'edits must be a non-empty array')
  }
  const over = overLimit('bulkEdits', edits.length)
  if (over) return response.json.error(413, over)

  const errors: FieldError[] = []
  const prepared = edits.map((edit, index) => {
    if (!isRecord(edit)) {
      errors.push({
        row: index,
        column: '',
        code: 'not_an_edit',
        message: 'expected an object',
      })
      return null
    }
    const key = validateKey(edit.key, table, index)
    const set = validatePartial(edit.set, table, index, {
      allowUncomparable: true,
      label: 'set',
    })
    const expect = validatePartial(edit.expect ?? {}, table, index, {
      allowUncomparable: false,
      label: 'expect',
    })
    errors.push(...key.errors, ...set.errors, ...expect.errors)
    if (!Object.keys(set.values).length) {
      errors.push({
        row: index,
        column: '',
        code: 'empty_set',
        message: 'set names no columns',
      })
    }
    return { key: key.where, set: set.values, expect: expect.values }
  })
  if (errors.length) return invalid(errors)

  const dryRun = body.dryRun === true

  return await Try.return(
    async () =>
      await DB.transaction(async () => {
        const conflicts: Conflict[] = []
        let changed = 0

        const { collapsible, single } = groupBulkEdits(prepared)

        for (const group of collapsible) {
          changed += await applyCollapsedGroup(table, group, conflicts)
        }

        for (const index of single) {
          const edit = prepared[index]!
          const predicate = { ...edit.key, ...edit.expect }
          const result = await chain(
            (column, value) =>
              DB.Update.table(table.name).set(edit.set).where(column, value),
            predicate,
          ).run()

          const rows = Number(result.changes ?? 0)
          if (rows > 0) {
            changed += rows
            continue
          }
          // Same MySQL no-op probe as the single-row path.
          if (await selectRow(table, predicate)) continue
          conflicts.push({
            index,
            key: edit.key,
            reason: 'the row changed since it was read',
            row: await selectRow(table, edit.key),
          })
        }

        // **All or nothing.** A bulk edit is one action from the user's side,
        // and a partial apply leaves them with no way to know which half
        // landed — the retry then double-applies whatever succeeded. Any
        // conflict rolls the whole transaction back.
        if (conflicts.length) conflictRollback({ changed: 0, conflicts })
        if (dryRun) previewRollback({ changed, conflicts })
        return response.json.success('updated', { changed, conflicts })
      }),
    fromRollback,
  )
}

// -------------------------------------------------------------- DELETE /rows

export async function handleDeleteRows(
  req: Request,
): Promise<JsonResponseData<unknown>> {
  const start = await beginWrite(req)
  if (!start.ok) return start.response
  const { table, body } = start

  const keys = body.keys
  if (!Array.isArray(keys) || !keys.length) {
    return response.json.error(400, 'keys must be a non-empty array')
  }
  const over = overLimit('deleteKeys', keys.length)
  if (over) return response.json.error(413, over)

  // Parallel to `keys`, not one shared object: a delete guarded by "the row
  // still looks like this" needs a different expectation per row, and a single
  // shared one would only ever be right for a single-row delete.
  const expectations = body.expect
  if (expectations !== undefined) {
    if (!Array.isArray(expectations) || expectations.length !== keys.length) {
      return response.json.error(
        400,
        'expect must be an array parallel to keys',
      )
    }
  }

  const errors: FieldError[] = []
  const prepared = keys.map((key, index) => {
    const validated = validateKey(key, table, index)
    errors.push(...validated.errors)
    const raw = Array.isArray(expectations) ? expectations[index] : undefined
    const expect =
      raw === undefined || raw === null
        ? { values: {}, errors: [] }
        : validatePartial(raw, table, index, {
            allowUncomparable: false,
            label: 'expect',
          })
    errors.push(...expect.errors)
    return { key: validated.where, expect: expect.values }
  })
  if (errors.length) return invalid(errors)

  const dryRun = body.dryRun === true

  return await Try.return(
    async () =>
      await DB.transaction(async () => {
        const conflicts: Conflict[] = []
        let deleted = 0

        for (let index = 0; index < prepared.length; index++) {
          const target = prepared[index]!
          const predicate = { ...target.key, ...target.expect }
          const result = await chain(
            (column, value) => DB.Delete.from(table.name).where(column, value),
            predicate,
          ).run()

          const rows = Number(result.changes ?? 0)
          if (rows > 0) {
            deleted += rows
            continue
          }
          // No no-op case here: a DELETE that matched a row always reports it.
          // Zero means the row is not there, or no longer matches `expect`.
          conflicts.push({
            index,
            key: target.key,
            reason: 'the row is gone or no longer matches expect',
            row: await selectRow(table, target.key),
          })
        }

        if (conflicts.length) conflictRollback({ deleted: 0, conflicts })
        if (dryRun) previewRollback({ deleted, conflicts })
        return response.json.success('deleted', { deleted, conflicts })
      }),
    fromRollback,
  )
}
