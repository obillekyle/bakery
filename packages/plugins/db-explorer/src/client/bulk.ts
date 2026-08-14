/**
 * Actions over a selection: set one column across it, delete it, or add rows.
 *
 * **Every count that reaches a dialog comes from a `dryRun`.** The server
 * executes the statements inside a transaction and rolls back, so the number is
 * what would actually happen — not the number of checkboxes, which is the same
 * number only when nothing has changed underneath and no key has gone missing.
 * `confirm.ts` turns that count into the right amount of ceremony.
 */

import { coerceValue, omittableOnInsert } from '../shared/coerce'
import { type ApiError, bulkEdit, deleteRows, insertRows } from './api'
import { confirmDanger, notify, offerUndo } from './confirm'
import { append, box, button, each, el, select } from './dom'
import type { UndoStack } from './edit-session'
import { createEditor } from './editors'
import { columnMeta, type SchemaColumn, type SchemaTable } from './meta'

export interface BulkContext {
  table: SchemaTable
  columns: SchemaColumn[]
  editable: boolean
  selectedKeys: () => Record<string, unknown>[]
  selectedRows: () => Record<string, unknown>[]
  reload: () => Promise<void>
  undo: UndoStack
  openImport: () => void
}

export interface BulkToolbar {
  node: HTMLElement
  setCount: (count: number) => void
}

export function bulkToolbar(ctx: BulkContext): BulkToolbar {
  const node = box('toolbar')
  const count = el('span', { class: 'note' })

  if (!ctx.editable) {
    node.appendChild(
      el('span', { class: 'note', text: ctx.table.reason ?? 'read-only' }),
    )
    return { node, setCount: () => {} }
  }

  const setColumn = button('Set column…', () => void openSetColumn(ctx), {
    class: 'btn',
  })
  const remove = button('Delete', () => void runDelete(ctx), {
    class: 'btn danger-btn',
  })
  const add = button('Add rows…', () => openInsert(ctx), { class: 'btn' })
  const importer = button('Import CSV…', ctx.openImport, { class: 'btn' })

  append(node, [add, importer, setColumn, remove, count])

  const setCount = (selected: number) => {
    count.textContent = selected ? `${selected} selected` : ''
    setColumn.disabled = selected === 0
    remove.disabled = selected === 0
  }
  setCount(0)
  return { node, setCount }
}

// ------------------------------------------------------------ set one column

/**
 * One column, one value, across the selection.
 *
 * The value goes through the same editor the grid uses, so an enum is a select
 * and a nullable column can be set to NULL — the operation people actually
 * reach for and the one a plain text prompt cannot express.
 */
async function openSetColumn(ctx: BulkContext): Promise<void> {
  const editable = ctx.columns.filter(column => !column.autoIncrement)
  const first = editable[0]
  if (!first) return

  const dialog = el('dialog', { class: 'danger' })
  dialog.appendChild(el('h3', { text: 'Set a column across the selection' }))

  let column = first
  let value: unknown = null
  const slot = box('panel-field')

  const paint = () => {
    slot.replaceChildren()
    const editor = createEditor(column, null, {
      onInput: next => {
        value = next
      },
      onKey: () => {},
    })
    slot.appendChild(editor.node)
    value = editor.read()
  }

  const picker = select(
    editable.map(c => ({ value: c.name, label: `${c.name} — ${c.type}` })),
    column.name,
    name => {
      column = editable.find(c => c.name === name) ?? column
      paint()
    },
  )
  paint()

  const apply = button(
    'Apply',
    () => {
      dialog.close()
      void applySetColumn(ctx, column, value)
    },
    { class: 'btn primary' },
  )
  const cancel = button('Cancel', () => dialog.close(), { class: 'btn' })
  const bar = box('row-bar', cancel, apply)
  append(dialog, [picker, slot, bar])

  document.body.appendChild(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
}

async function applySetColumn(
  ctx: BulkContext,
  column: SchemaColumn,
  value: unknown,
): Promise<void> {
  const check = coerceValue(value, columnMeta(column))
  if (!check.ok) {
    notify(`${column.name}: ${check.message}`, 'error')
    return
  }

  const edits = ctx
    .selectedKeys()
    .map(key => ({ key, set: { [column.name]: check.value } }))
  if (!edits.length) return

  const dry = await dryRun(() =>
    bulkEdit({ table: ctx.table.name, edits, dryRun: true }),
  )
  if (!dry) return

  const decision = await confirmDanger({
    verb: `set ${column.name}`,
    count: dry.changed,
    table: ctx.table.name,
    detail: `to ${describe(check.value)}`,
  })
  if (decision.refusal) return notify(decision.refusal, 'error')
  if (!decision.ok) return

  await run(async () => {
    const result = await bulkEdit({ table: ctx.table.name, edits })
    notify(`${result.changed} rows updated`)
    await ctx.reload()
  })
}

function describe(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

// -------------------------------------------------------------------- delete

async function runDelete(ctx: BulkContext): Promise<void> {
  const keys = ctx.selectedKeys()
  const rows = ctx.selectedRows()
  if (!keys.length) return

  const dry = await dryRun(() =>
    deleteRows({ table: ctx.table.name, keys, dryRun: true }),
  )
  if (!dry) return

  const decision = await confirmDanger({
    verb: 'delete',
    count: dry.deleted,
    table: ctx.table.name,
    detail: dry.conflicts.length
      ? `${dry.conflicts.length} of the selected rows no longer match`
      : undefined,
  })
  if (decision.refusal) return notify(decision.refusal, 'error')
  if (!decision.ok) return

  await run(async () => {
    const result = await deleteRows({ table: ctx.table.name, keys })
    await ctx.reload()
    offerDeleteUndo(ctx, rows, result.deleted)
  })
}

/**
 * A ten-second offer to put the row back.
 *
 * Only for the immediate tier — anything above one row went through a dialog,
 * and re-inserting a hundred rows from the browser's memory is a second bulk
 * write dressed up as a safety net. The pre-image is already in hand because
 * the grid holds the rows it rendered.
 */
function offerDeleteUndo(
  ctx: BulkContext,
  rows: Record<string, unknown>[],
  deleted: number,
): void {
  if (deleted !== 1 || rows.length !== 1) {
    notify(`${deleted} rows deleted`)
    return
  }
  const row = rows[0]!
  const restore = async () => {
    await run(async () => {
      await insertRows({ table: ctx.table.name, rows: [row] })
      await ctx.reload()
    })
  }
  ctx.undo.push({ label: `delete from ${ctx.table.name}`, undo: restore })
  offerUndo('1 row deleted', restore)
}

// -------------------------------------------------------------------- insert

/**
 * Add rows by hand.
 *
 * A column is sent only when the user gave it a value or when the database
 * cannot supply one — `omittableOnInsert` is the same predicate the importer's
 * blocking check uses. Sending every column would defeat every default in the
 * schema and would make an auto-increment key impossible to leave alone.
 */
function openInsert(ctx: BulkContext): void {
  const columns = ctx.columns.filter(column => !column.autoIncrement)
  const dialog = el('dialog', { class: 'danger wide' })
  dialog.appendChild(el('h3', { text: `Add rows to ${ctx.table.name}` }))

  const list = box('insert-rows')
  const drafts: Map<string, unknown>[] = []

  const addRow = () => {
    const draft = new Map<string, unknown>()
    drafts.push(draft)
    const row = box('insert-row')
    row.appendChild(el('span', { class: 'note', text: `row ${drafts.length}` }))
    each(row, columns, column => insertField(column, draft))
    list.appendChild(row)
  }
  addRow()

  const message = el('p', { class: 'row-error' })
  const submit = button(
    'Insert',
    () => {
      const built = buildInsertRows(columns, drafts)
      if (built.errors.length) {
        message.textContent = built.errors.join('; ')
        return
      }
      dialog.close()
      void run(async () => {
        const result = await insertRows({
          table: ctx.table.name,
          rows: built.rows,
        })
        notify(`${result.inserted} rows inserted`)
        await ctx.reload()
      })
    },
    { class: 'btn primary' },
  )

  const bar = box(
    'row-bar',
    button('+ row', addRow, { class: 'btn' }),
    button('Cancel', () => dialog.close(), { class: 'btn' }),
    submit,
  )
  append(dialog, [list, message, bar])
  document.body.appendChild(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
}

function insertField(column: SchemaColumn, draft: Map<string, unknown>): Node {
  const wrap = box('panel-field')
  wrap.appendChild(el('label', { class: 'panel-label', text: column.name }))
  const editor = createEditor(column, null, {
    onInput: value => draft.set(column.name, value),
    onKey: () => {},
  })
  wrap.appendChild(editor.node)
  return wrap
}

export interface BuiltRows {
  rows: Record<string, unknown>[]
  errors: string[]
}

/**
 * Drafts to records, with the same coercion the server will apply.
 *
 * Exported because it is the decision in this file that is worth pinning: an
 * untouched omittable column is *absent* from the record, and an untouched
 * required one is an error named here rather than a database exception later.
 */
export function buildInsertRows(
  columns: readonly SchemaColumn[],
  drafts: readonly Map<string, unknown>[],
): BuiltRows {
  const rows: Record<string, unknown>[] = []
  const errors: string[] = []

  drafts.forEach((draft, index) => {
    const record: Record<string, unknown> = {}
    for (const column of columns) {
      const meta = columnMeta(column)
      const given = draft.has(column.name)
      if (!given && omittableOnInsert(meta)) continue
      const result = coerceValue(draft.get(column.name) ?? null, meta)
      if (!result.ok) {
        errors.push(`row ${index + 1} · ${column.name}: ${result.message}`)
        continue
      }
      record[column.name] = result.value
    }
    rows.push(record)
  })

  return { rows, errors }
}

// ------------------------------------------------------------------ plumbing

/** A dry run, with its failure reported rather than thrown at the click handler. */
async function dryRun<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call()
  } catch (error) {
    notify(messageOf(error), 'error')
    return null
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    notify(messageOf(error), 'error')
  }
}

export function messageOf(error: unknown): string {
  const api = error as Partial<ApiError>
  return api?.message ?? String(error)
}
