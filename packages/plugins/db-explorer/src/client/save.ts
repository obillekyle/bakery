/**
 * Saving one row, and the conflict that is the interesting half.
 *
 * Kept apart from the page because it is the part with a decision in it: a
 * rejected write must never be a lost edit, and a 409 must not be answered with
 * a retry button. "Try again" against a row that moved is precisely how the
 * other person's edit disappears.
 */

import type { ColumnKind } from '../shared/coerce'
import { type ApiError, messageOf, patchRow } from './api'
import { box, button, el } from './dom'
import type { EditSession, RowPlan } from './edit-session'
import type { SchemaTable } from './meta'

/**
 * The part of the grid a save needs. Structural, so `Grid` satisfies it
 * without knowing this module exists.
 */
export interface RowSurface {
  indexOfRow: (id: string) => number
  setRowMessage: (index: number, message: string) => void
  setRowBusy: (index: number, busy: boolean) => void
}

export interface SaveDeps {
  session: EditSession
  /** Read late: the grid is replaced on every repaint. */
  surface: () => RowSurface | null
  reload: () => Promise<void>
  onDirtyChange: () => void
}

function kindLookup(
  table: SchemaTable,
): (column: string) => ColumnKind | undefined {
  const kinds = new Map(table.columns.map(c => [c.name, c.kind as ColumnKind]))
  return column => kinds.get(column)
}

/**
 * One row, one PATCH, carrying every changed column and its pre-image.
 *
 * The pre-image goes as `expect`, so the statement is `identity ∧ expect` and a
 * concurrent edit is a 409 rather than a silent overwrite. `force` is sent only
 * when a changed column is `json` or `buffer` — kinds SQL cannot compare, so
 * there is no predicate to guard them with.
 */
export async function saveRow(
  table: SchemaTable,
  id: string,
  deps: SaveDeps,
): Promise<void> {
  const surface = deps.surface()
  const plan = deps.session.plan(id, table.identity.cols, kindLookup(table))
  if (!plan || !surface) return

  const index = surface.indexOfRow(id)
  if (plan.missingIdentity.length) {
    surface.setRowMessage(
      index,
      `this row is missing ${plan.missingIdentity.join(', ')}`,
    )
    return
  }

  surface.setRowBusy(index, true)
  try {
    await send(table, plan, plan.expect)
    deps.session.drop(id)
    deps.onDirtyChange()
    await deps.reload()
  } catch (error) {
    surface.setRowBusy(index, false)
    await reportFailure(table, id, index, error, deps)
  }
}

function send(
  table: SchemaTable,
  plan: RowPlan,
  expect: Record<string, unknown>,
): Promise<unknown> {
  return patchRow({
    table: table.name,
    key: plan.where,
    set: plan.set,
    expect,
    force: plan.unguardable.length > 0,
  })
}

/** The typed values survive. Anything else would make the buffer pointless. */
async function reportFailure(
  table: SchemaTable,
  id: string,
  index: number,
  error: unknown,
  deps: SaveDeps,
): Promise<void> {
  const api = error as ApiError
  const surface = deps.surface()
  if (api?.status !== 409) {
    surface?.setRowMessage(index, messageOf(error))
    return
  }
  const theirs = (api.data as { row?: Record<string, unknown> } | undefined)
    ?.row
  surface?.setRowMessage(index, 'this row changed since it was read')
  await offerResolution(table, id, index, theirs ?? null, deps)
}

/**
 * Keep mine / Take theirs, with the server's copy of the row in hand.
 *
 * The 409 body carries the row as it now stands — that is why the endpoint
 * attaches it — so this is a real choice rather than a prompt to guess.
 */
function offerResolution(
  table: SchemaTable,
  id: string,
  index: number,
  theirs: Record<string, unknown> | null,
  deps: SaveDeps,
): Promise<void> {
  let settle: () => void = () => {}
  const done = new Promise<void>(resolve => {
    settle = resolve
  })

  const dialog = el('dialog', { class: 'danger' })
  dialog.appendChild(
    el('h3', { text: 'This row changed while you were editing' }),
  )
  dialog.appendChild(
    el('p', {
      class: 'note',
      text: theirs
        ? 'Keep mine re-sends your columns against the row as it is now. ' +
          'Take theirs discards your edits.'
        : 'The row is gone. Your edits cannot be applied to it.',
    }),
  )

  const takeTheirs = button(
    'Take theirs',
    () => {
      deps.session.drop(id)
      dialog.close()
      void deps.reload().then(settle, settle)
    },
    { class: 'btn' },
  )

  const keepMine = button(
    'Keep mine',
    () => {
      dialog.close()
      void rebase(table, id, index, theirs, deps).then(settle, settle)
    },
    { class: 'btn primary' },
  )
  keepMine.disabled = theirs === null

  dialog.appendChild(box('row-bar', takeTheirs, keepMine))
  document.body.appendChild(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
  return done
}

/**
 * Keep mine: the same `set`, with `expect` taken from *their* row.
 *
 * Not `expect: {}` — that is last-write-wins, which the endpoint refuses to
 * default to for exactly this reason. Rebasing on the row that was just shown
 * means a *third* edit arriving between the 409 and this retry is a 409 again,
 * which is the correct answer rather than an inconvenience.
 */
async function rebase(
  table: SchemaTable,
  id: string,
  index: number,
  theirs: Record<string, unknown> | null,
  deps: SaveDeps,
): Promise<void> {
  const surface = deps.surface()
  if (!theirs || !surface) return
  const plan = deps.session.plan(id, table.identity.cols, kindLookup(table))
  if (!plan) return

  const expect: Record<string, unknown> = {}
  for (const column of Object.keys(plan.expect)) expect[column] = theirs[column]

  surface.setRowBusy(index, true)
  try {
    await send(table, plan, expect)
    deps.session.drop(id)
    deps.onDirtyChange()
    await deps.reload()
  } catch (error) {
    surface.setRowBusy(index, false)
    surface.setRowMessage(index, messageOf(error))
  }
}
