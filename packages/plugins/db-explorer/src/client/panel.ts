/**
 * The row side panel — one row, as a form.
 *
 * Promoted from `drawer.ts`, which did the same job with less of it. The grid
 * is the right shape for scanning and the wrong shape for a forty-column row:
 * editing one means horizontal scrolling past thirty-nine others, and a `json`
 * column gets a cell six characters tall. The panel reuses the same editors and
 * the same `EditSession`, so a value staged here is the same staged value the
 * grid shows, and one Save covers both.
 *
 * What it adds over the drawer:
 *
 *  - **Long text and JSON get a textarea**, which is the whole reason a panel
 *    beats a cell for those two.
 *  - **Both directions of the graph.** "References" jumps to the row this one
 *    points at; "Referenced by" lists the rows pointing here.
 *  - **Exact counts.** They used to be labelled approximate and were: the only
 *    filter available was a substring `LIKE`, so a row with id `1` counted `11`
 *    and `21` too. With `eq` the number is the number.
 *
 * "Referenced by" is still **lazy** — one request per referencing table, issued
 * when the section is opened. Doing that for every visible row would be the
 * per-cell `fetch` that `fk.ts` exists to avoid, in a different costume.
 */

import type { Filter } from '../shared/filters'
import { fetchPage } from './api'
import { append, box, button, each, el, on } from './dom'
import { type EditSession, rowId } from './edit-session'
import { createEditor } from './editors'
import { equalityFilters } from './filter-builder'
import { fkForColumn, fkKeyOf } from './fk'
import {
  cellText,
  type SchemaColumn,
  type SchemaGraph,
  type SchemaTable,
} from './meta'
import { filtersForIncoming, type Relation, relationsFor } from './relations'
import { defaultView } from './state'

export interface PanelContext {
  table: SchemaTable
  columns: SchemaColumn[]
  row: Record<string, unknown>
  editable: boolean
  graph: SchemaGraph | null
  session: EditSession
  onSave: (id: string) => void
  onDirtyChange: () => void
  /** Open another table in a tab, filtered. */
  onNavigate: (table: string, filters: Filter[]) => void
}

export interface PanelHandle {
  close: () => void
  setMessage: (message: string) => void
}

export function openPanel(ctx: PanelContext): PanelHandle {
  const id = rowId(ctx.row, ctx.table.identity.cols)
  const panel = el('aside', {
    class: 'panel',
    attrs: { role: 'dialog', 'aria-label': `row in ${ctx.table.name}` },
  })

  const message = el('p', { class: 'row-error' })
  const close = () => panel.remove()

  append(panel, [
    header(ctx, close),
    fields(ctx, id),
    footer(ctx, id, message),
    message,
    references(ctx),
    referencedBy(ctx),
  ])

  document.body.appendChild(panel)
  return { close, setMessage: text => (message.textContent = text) }
}

function header(ctx: PanelContext, close: () => void): HTMLElement {
  const head = box('panel-head')
  const name = el('h3', { text: ctx.table.name })
  const key = el('p', {
    class: 'note',
    text: ctx.table.identity.cols
      .map(column => `${column}=${cellText(ctx.row[column])}`)
      .join(' · '),
  })
  const title = box('panel-title', name, key)
  append(head, [title, button('Close', close, { class: 'btn' })])
  return head
}

function fields(ctx: PanelContext, id: string | null): HTMLElement {
  const list = box('panel-fields')
  each(list, ctx.columns, column => field(ctx, id, column))
  return list
}

/**
 * One column: its name, its declared type, and an editor or a read-only value.
 *
 * The same `createEditor` the grid opens in a cell — including the null toggle,
 * which is the whole reason a 40-column row is editable here at all: several of
 * those columns are nullable, and a form of plain text inputs cannot say so.
 * `multiline` is the one difference, and it is what makes this the place long
 * text gets edited.
 */
function field(
  ctx: PanelContext,
  id: string | null,
  column: SchemaColumn,
): HTMLElement {
  const wrap = box('panel-field')
  append(wrap, [
    el('label', { class: 'panel-label', text: column.name }),
    el('span', { class: 'note', text: typeNote(column) }),
  ])

  const current = id
    ? ctx.session.value(id, column.name, ctx.row[column.name])
    : ctx.row[column.name]

  if (!ctx.editable || !id) {
    wrap.appendChild(
      el('div', { class: 'panel-value', text: cellText(current) }),
    )
    return wrap
  }

  const editor = createEditor(
    column,
    current,
    {
      // In the panel there is no cursor to move, so every change stages
      // immediately. Same buffer, same Save — the difference is only that the
      // grid needs a commit key to know where to go next and this does not.
      onInput: value => {
        ctx.session.stage(id, ctx.row, column.name, value)
        ctx.onDirtyChange()
      },
      onKey: () => {},
    },
    { multiline: true },
  )
  wrap.appendChild(editor.node)
  return wrap
}

function typeNote(column: SchemaColumn): string {
  const parts = [column.type]
  if (!column.nullable) parts.push('NOT NULL')
  if (column.pk) parts.push('PK')
  if (column.autoIncrement) parts.push('AUTO')
  return parts.join(' · ')
}

function footer(
  ctx: PanelContext,
  id: string | null,
  message: HTMLElement,
): HTMLElement {
  const bar = box('row-bar open')
  if (!ctx.editable || !id) {
    bar.appendChild(
      el('span', { class: 'note', text: ctx.table.reason ?? 'read-only' }),
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
 * The rows *this* row points at — one link per outgoing foreign key.
 *
 * Not lazy, because it costs nothing: the key is already in the row, so the
 * link is built from data in hand and only the click spends a request. A key
 * whose columns are NULL points at nothing and is listed as such rather than
 * offered as a link that would land on an empty page.
 */
function references(ctx: PanelContext): HTMLElement | null {
  const outgoing = relationsFor(ctx.graph, ctx.table.name).outgoing
  if (!outgoing.length) return null

  const section = el('details', { class: 'panel-refs' })
  section.appendChild(el('summary', { text: `references ${outgoing.length}` }))
  const list = box('panel-ref-list')
  each(list, outgoing, relation => referenceRow(ctx, relation))
  section.appendChild(list)
  return section
}

function referenceRow(ctx: PanelContext, relation: Relation): HTMLElement {
  const row = box('panel-ref')
  const target = fkForColumn(ctx.graph, ctx.table.name, relation.cols[0] ?? '')
  const key = target ? fkKeyOf(target, ctx.row) : null

  if (!key) {
    append(row, [
      el('span', {
        class: 'note',
        text: `${relation.cols.join(', ')} → ${relation.table} (NULL)`,
      }),
    ])
    return row
  }

  append(row, [
    el('span', { class: 'note', text: `${relation.cols.join(', ')} →` }),
    button(
      relation.table,
      () => ctx.onNavigate(relation.table, equalityFilters(key)),
      { class: 'btn', title: `open the referenced row in ${relation.table}` },
    ),
  ])
  return row
}

/**
 * Tables that point at this row, resolved when the section is opened.
 *
 * The counts are **exact**. They used to be labelled approximate and were —
 * the only filter the table-data endpoint offered was `col LIKE '%value%'`, so
 * a row with id `1` matched `11` and `21` too. `eq` removed the caveat along
 * with the reason for it.
 */
function referencedBy(ctx: PanelContext): HTMLElement | null {
  const incoming = relationsFor(ctx.graph, ctx.table.name).incoming
  if (!incoming.length) return null

  const section = el('details', { class: 'panel-refs' })
  section.appendChild(
    el('summary', { text: `referenced by ${incoming.length}` }),
  )
  const list = box('panel-ref-list')
  section.appendChild(list)

  let loaded = false
  on(section, 'toggle', () => {
    if (!section.open || loaded) return
    loaded = true
    each(list, incoming, relation => incomingRow(ctx, relation))
  })
  return section
}

function incomingRow(ctx: PanelContext, relation: Relation): HTMLElement {
  const filters = filtersForIncoming(relation, ctx.row)
  const row = box('panel-ref')
  const count = el('span', { class: 'note', text: 'counting…' })

  append(row, [
    button(
      `${relation.table}.${relation.cols.join(', ')}`,
      () => ctx.onNavigate(relation.table, filters),
      { class: 'btn' },
    ),
    count,
  ])

  void countRows(relation.table, filters).then(
    total => {
      count.textContent = total === null ? '' : `${total} rows`
    },
    () => {
      // The link is still useful without the count, and a failed count is not
      // worth an error banner over a row the user has not asked to see yet.
      count.textContent = ''
    },
  )
  return row
}

async function countRows(
  table: string,
  filters: Filter[],
): Promise<number | null> {
  const page = await fetchPage({ ...defaultView(table), filters })
  return page.data.totalRows ?? null
}
