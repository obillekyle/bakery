/**
 * The per-row dirty buffer, and the statement it becomes.
 *
 * **Pure — no DOM, no fetch.** This is where the editing model actually lives,
 * so it is the part with tests. The grid is a view over it.
 *
 * Three properties it exists to hold:
 *
 *  1. **A row is one save.** Editing three columns produces one PATCH carrying
 *     all three, not three PATCHes. The dashboard's save-on-blur produced the
 *     latter, which means a reader can observe the row a third of the way
 *     through an edit the user considers atomic.
 *  2. **The pre-image is kept.** `expect` is built from the row as it was
 *     *read*, never from a re-read at save time — a re-read would defeat the
 *     concurrency check it exists to perform.
 *  3. **Unchanged columns are dropped**, by `updatePlan`, so two people editing
 *     different columns of one row do not collide.
 */

import { type ColumnKind, comparableKind, sameValue } from '../shared/coerce'
import { updatePlan } from '../shared/plan'

/**
 * A row's identity, flattened to a string.
 *
 * `JSON.stringify` over the identity columns in their declared order — the
 * order is the server's, from `identity.cols`, so it is stable across pages and
 * across a composite key's spelling. `null` when the row does not carry every
 * identity column, which is the same condition `updatePlan` reports as
 * `missingIdentity` and means the row cannot be addressed at all.
 */
export function rowId(
  row: Record<string, unknown>,
  identity: readonly string[],
): string | null {
  if (!identity.length) return null
  const parts: unknown[] = []
  for (const column of identity) {
    if (!(column in row)) return null
    parts.push(row[column])
  }
  return JSON.stringify(parts)
}

export interface RowPlan {
  /** Columns that actually differ, and the values to write. */
  set: Record<string, unknown>
  /** The identity predicate, from the pre-image. */
  where: Record<string, unknown>
  /** The pre-image of every changed column that SQL can compare. */
  expect: Record<string, unknown>
  /**
   * Changed columns SQL cannot compare — `json` and `buffer`. The server
   * refuses these in `expect` and demands `force: true` to write them without
   * a concurrency check, so the UI has to say so rather than retry blindly.
   */
  unguardable: string[]
  /** Edited keys whose value matched what was already there. */
  unchanged: string[]
  /** Identity columns the pre-image does not carry. Non-empty means unusable. */
  missingIdentity: string[]
}

export type KindLookup = (column: string) => ColumnKind | undefined

/**
 * Staged edits for the rows currently on screen.
 *
 * Bounded by construction: an entry exists only for a row the user has typed
 * into, they are dropped on save and on revert, and changing table or page
 * clears the whole session — there is no key here a page of data does not
 * already hold (convention 6).
 */
export class EditSession {
  private readonly edits = new Map<string, Map<string, unknown>>()
  private readonly originals = new Map<string, Record<string, unknown>>()

  /**
   * Record an edited value.
   *
   * Staging a value equal to the original **unstages** it, so typing a change
   * and typing it back leaves the row clean rather than dirty-with-no-diff.
   * `sameValue` rather than `===`, for the reason its own comment gives: the
   * original came from a driver and the edit came from an input, and `1` vs
   * `true` is not an edit the user made.
   */
  stage(
    id: string,
    original: Record<string, unknown>,
    column: string,
    value: unknown,
  ): void {
    if (!this.originals.has(id)) this.originals.set(id, original)
    const pre = this.originals.get(id)!
    const row = this.edits.get(id) ?? new Map<string, unknown>()
    if (sameValue(pre[column], value)) row.delete(column)
    else row.set(column, value)
    if (row.size) this.edits.set(id, row)
    else this.drop(id)
  }

  /** The value to show in a cell: the staged one, else the original. */
  value(id: string, column: string, fallback: unknown): unknown {
    const row = this.edits.get(id)
    return row?.has(column) ? row.get(column) : fallback
  }

  isStaged(id: string, column: string): boolean {
    return this.edits.get(id)?.has(column) ?? false
  }

  changedColumns(id: string): string[] {
    return [...(this.edits.get(id)?.keys() ?? [])]
  }

  isDirty(id: string): boolean {
    return (this.edits.get(id)?.size ?? 0) > 0
  }

  /** How many rows are dirty. What the header badge and the unload guard read. */
  dirtyRows(): number {
    return this.edits.size
  }

  dirtyIds(): string[] {
    return [...this.edits.keys()]
  }

  original(id: string): Record<string, unknown> | undefined {
    return this.originals.get(id)
  }

  drop(id: string): void {
    this.edits.delete(id)
    this.originals.delete(id)
  }

  clear(): void {
    this.edits.clear()
    this.originals.clear()
  }

  /**
   * One row's edits as an UPDATE.
   *
   * `where` comes from the pre-image and `set` from the edits, which is what
   * lets a primary key itself be edited — see `updatePlan`'s own note.
   */
  plan(
    id: string,
    identity: readonly string[],
    kindOf: KindLookup,
  ): RowPlan | null {
    const original = this.originals.get(id)
    const edits = this.edits.get(id)
    if (!original || !edits?.size) return null

    const plan = updatePlan({
      original,
      edits: Object.fromEntries(edits),
      identity,
    })

    const expect: Record<string, unknown> = {}
    const unguardable: string[] = []
    for (const column of Object.keys(plan.set)) {
      const kind = kindOf(column)
      // Unknown kind is treated as guardable: the column came out of the
      // server's own schema report, so an absent entry is a bug rather than a
      // JSON column, and including it in `expect` fails loudly at validation
      // instead of silently dropping the concurrency check.
      if (kind && !comparableKind(kind)) unguardable.push(column)
      else expect[column] = original[column]
    }

    return { ...plan, expect, unguardable }
  }
}

export interface UndoEntry {
  label: string
  /** Runs the inverse. Rejects like any other request; the caller reports it. */
  undo: () => Promise<void>
}

/**
 * The last twenty things that happened, newest first.
 *
 * Twenty rather than unlimited because each entry closes over a row's
 * pre-image, and an unbounded stack of those is exactly the module-level
 * unbounded cache convention 6 forbids. The pre-image is already being kept for
 * the concurrency check, so undo costs nothing extra to record — only to keep.
 */
export class UndoStack {
  private readonly entries: UndoEntry[] = []

  constructor(readonly limit = 20) {}

  push(entry: UndoEntry): void {
    this.entries.unshift(entry)
    if (this.entries.length > this.limit) this.entries.length = this.limit
  }

  get size(): number {
    return this.entries.length
  }

  peek(): UndoEntry | undefined {
    return this.entries[0]
  }

  pop(): UndoEntry | undefined {
    return this.entries.shift()
  }

  clear(): void {
    this.entries.length = 0
  }
}
