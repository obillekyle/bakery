/**
 * The table list, and the one checkbox that decides what is in it.
 *
 * Split out of `page.ts` when tabs arrived: the sidebar is the only thing left
 * that survives a tab switch, so it repaints on a different schedule from
 * everything else and had no business sharing a module with the grid's chrome.
 *
 * A **single click opens a preview tab** and a **double click makes it
 * permanent** — the two are wired here and defined in `tabs.ts`.
 */

import { append, box, button, each, el, on } from './dom'
import type { SchemaTable } from './meta'
import { systemTableCount, visibleTables } from './state'

export interface SidebarContext {
  tables: readonly SchemaTable[]
  showSystem: boolean
  /** The table showing in the active tab, so it can be marked. */
  activeTable: string | null
  /** Single click: a replaceable preview tab. */
  onPreview: (table: string) => void
  /** Double click: a tab that stays. */
  onOpen: (table: string) => void
  onToggleSystem: (show: boolean) => void
}

export function renderSidebar(ctx: SidebarContext): HTMLElement {
  const side = el('nav', { class: 'side' })
  side.appendChild(el('h1', { class: 'brand', text: 'db explorer' }))

  const shown = visibleTables(ctx.tables, ctx.showSystem)
  const list = box('table-list')
  each(list, shown, table => tableButton(ctx, table))
  side.appendChild(list)

  if (!shown.length) {
    side.appendChild(el('p', { class: 'note', text: 'no tables' }))
  }
  const toggle = systemToggle(ctx)
  if (toggle) side.appendChild(toggle)
  return side
}

/**
 * The system-tables checkbox, present only when there is something to reveal.
 *
 * `__bakery_schema` is the ORM's sync ledger and is not the user's data, so it
 * is hidden by default — but every real client offers the toggle rather than
 * hiding such tables outright, because a ledger row is occasionally exactly
 * what someone needs to see. The count is in the label so the checkbox says
 * what it would do before it is clicked.
 */
function systemToggle(ctx: SidebarContext): HTMLElement | null {
  const hidden = systemTableCount(ctx.tables)
  if (!hidden) return null

  const check = el('input', {
    attrs: { 'aria-label': 'show system tables' },
  })
  check.type = 'checkbox'
  check.checked = ctx.showSystem
  on(check, 'change', () => ctx.onToggleSystem(check.checked))

  const label = el('label', {
    class: 'note system-toggle',
    text: ` show system tables (${hidden})`,
    title: "the framework's own bookkeeping — the ORM sync ledger",
  })
  label.prepend(check)
  return label
}

function tableButton(ctx: SidebarContext, table: SchemaTable): HTMLElement {
  const node = button(table.name, () => ctx.onPreview(table.name), {
    class: 'table-btn',
  })
  // `dblclick` fires *after* its two `click`s, so the single click has already
  // opened the preview tab and this only promotes it — which is exactly VS
  // Code's behaviour and needs no suppression of the first click.
  on(node, 'dblclick', () => ctx.onOpen(table.name))

  if (table.name === ctx.activeTable) node.classList.add('active')
  append(node, [badgeFor(table)])
  return node
}

/**
 * A padlock for read-only, a different mark for a view.
 *
 * On the *list*, so the state is visible before the table is opened rather than
 * at the first double-click into a cell.
 */
function badgeFor(table: SchemaTable): HTMLElement | null {
  if (table.isView) {
    return el('span', {
      class: 'ro',
      text: '⊞',
      title: 'a view — it has no rows of its own to address',
    })
  }
  if (!table.writable) {
    return el('span', {
      class: 'ro',
      text: '🔒',
      title: table.reason ?? 'read-only',
    })
  }
  return null
}
