/**
 * One row, as a form.
 *
 * The grid is the right shape for scanning and the wrong shape for a
 * forty-column row: editing one means horizontal scrolling past thirty-nine
 * others, and a `json` column gets a cell six characters tall. The drawer
 * reuses the same editors and the same `EditSession`, so a value staged here is
 * the same staged value the grid shows, and one Save covers both.
 *
 * **"Referenced by" lives here and nowhere else, and it is lazy.** Reverse
 * foreign keys are one request per referencing table; doing that for every
 * visible row would be the per-cell `fetch` that `fk.ts` exists to avoid, in a
 * different costume.
 */

import { fetchPage } from './api'
import { append, box, button, each, el, on } from './dom'
import { type EditSession, rowId } from './edit-session'
import { createEditor } from './editors'
import { reverseFks } from './fk'
import {
  cellText,
  type SchemaColumn,
  type SchemaGraph,
  type SchemaTable,
} from './meta'
import { defaultView } from './state'

export interface DrawerContext {
  table: SchemaTable
  columns: SchemaColumn[]
  row: Record<string, unknown>
  editable: boolean
  graph: SchemaGraph | null
  session: EditSession
  onSave: (id: string) => void
  onDirtyChange: () => void
  /** Jump to another table, filtered by a reverse reference. */
  onNavigate: (table: string, filters: Record<string, string>) => void
}

export interface DrawerHandle {
  close: () => void
  setMessage: (message: string) => void
}

export function openDrawer(ctx: DrawerContext): DrawerHandle {
  const id = rowId(ctx.row, ctx.table.identity.cols)
  const panel = el('aside', {
    class: 'drawer',
    attrs: { role: 'dialog', 'aria-label': `row in ${ctx.table.name}` },
  })

  const message = el('p', { class: 'row-error' })
  const close = () => panel.remove()

  append(panel, [
    header(ctx, close),
    fields(ctx, id),
    footer(ctx, id, message),
    message,
    referencedBy(ctx),
  ])

  document.body.appendChild(panel)
  return { close, setMessage: text => (message.textContent = text) }
}

function header(ctx: DrawerContext, close: () => void): HTMLElement {
  const head = box('drawer-head')
  const name = el('h3', { text: ctx.table.name })
  const key = el('p', {
    class: 'note',
    text: ctx.table.identity.cols
      .map(column => `${column}=${cellText(ctx.row[column])}`)
      .join(' · '),
  })
  const title = box('drawer-title', name, key)
  append(head, [title, button('Close', close, { class: 'btn' })])
  return head
}

function fields(ctx: DrawerContext, id: string | null): HTMLElement {
  const list = box('drawer-fields')
  each(list, ctx.columns, column => field(ctx, id, column))
  return list
}

/**
 * One column: its name, its declared type, and an editor or a read-only value.
 *
 * The same `createEditor` the grid opens in a cell — including the null toggle,
 * which is the whole reason a 40-column row is editable here at all: several of
 * those columns are nullable, and a form of plain text inputs cannot say so.
 */
function field(
  ctx: DrawerContext,
  id: string | null,
  column: SchemaColumn,
): HTMLElement {
  const wrap = box('drawer-field')
  const label = el('label', { class: 'drawer-label', text: column.name })
  const type = el('span', {
    class: 'note',
    text: `${column.type}${column.nullable ? '' : ' NOT NULL'}${column.pk ? ' PK' : ''}`,
  })
  append(wrap, [label, type])

  const current = id
    ? ctx.session.value(id, column.name, ctx.row[column.name])
    : ctx.row[column.name]

  if (!ctx.editable || !id) {
    wrap.appendChild(
      el('div', { class: 'drawer-value', text: cellText(current) }),
    )
    return wrap
  }

  const editor = createEditor(column, current, {
    // In the drawer there is no cursor to move, so every change stages
    // immediately. Same buffer, same Save — the difference is only that the
    // grid needs a commit key to know where to go next and this does not.
    onInput: value => {
      ctx.session.stage(id, ctx.row, column.name, value)
      ctx.onDirtyChange()
    },
    onKey: () => {},
  })
  wrap.appendChild(editor.node)
  return wrap
}

function footer(
  ctx: DrawerContext,
  id: string | null,
  message: HTMLElement,
): HTMLElement {
  const bar = box('row-bar open')
  if (!ctx.editable || !id) {
    bar.appendChild(
      el('span', {
        class: 'note',
        text: ctx.table.reason ?? 'read-only',
      }),
    )
    return bar
  }
  append(bar, [
    button('Save', () => ctx.onSave(id), { class: 'btn primary' }),
    button(
      'Revert',
      () => {
        ctx.session.drop(id)
        ctx.onDirtyChange()
        message.textContent =
          'reverted — reopen the row to see the stored values'
      },
      { class: 'btn' },
    ),
  ])
  return bar
}

/**
 * Tables that point at this row, resolved when the section is opened.
 *
 * The counts are **approximate and say so**: the only filter the table-data
 * endpoint offers is `col LIKE '%value%'`, so a row with id `1` matches `11`
 * and `21` too. Rendering that as an exact count would be a number that is
 * quietly wrong; the link itself is still the useful part.
 */
function referencedBy(ctx: DrawerContext): HTMLElement | null {
  const incoming = reverseFks(ctx.graph, ctx.table.name)
  if (!incoming.length) return null

  const section = el('details', { class: 'drawer-refs' })
  section.appendChild(
    el('summary', { text: `referenced by ${incoming.length}` }),
  )
  const list = box('drawer-ref-list')
  section.appendChild(list)

  let loaded = false
  on(section, 'toggle', () => {
    if (!section.open || loaded) return
    loaded = true
    each(list, incoming, fk => refRow(ctx, fk))
  })
  return section
}

function refRow(
  ctx: DrawerContext,
  fk: { table: string; cols: string[]; refCols: string[] },
): HTMLElement {
  const filters: Record<string, string> = {}
  fk.refCols.forEach((refCol, index) => {
    const value = ctx.row[refCol]
    const column = fk.cols[index]
    if (column && value !== null && value !== undefined) {
      filters[column] = String(value)
    }
  })

  const row = box('drawer-ref')
  const count = el('span', { class: 'note', text: 'counting…' })
  append(row, [
    button(
      `${fk.table}.${fk.cols.join(', ')}`,
      () => ctx.onNavigate(fk.table, filters),
      {
        class: 'btn',
      },
    ),
    count,
  ])

  void countRows(fk.table, filters).then(
    total => {
      count.textContent = total === null ? '' : `≈ ${total} rows`
      count.title =
        'approximate — the only available filter is a substring match'
    },
    () => {
      count.textContent = ''
    },
  )
  return row
}

async function countRows(
  table: string,
  filters: Record<string, string>,
): Promise<number | null> {
  const view = { ...defaultView(table), filters }
  const page = await fetchPage(view)
  return page.totalRows ?? null
}
