/**
 * The tab strip, and the view switcher under it.
 *
 * Two rows, and **exactly two** — the table tabs, then Data / Structure /
 * Relations for whichever table is active. Beekeeper sells itself on not having
 * "tabs within tabs", and it is right: one level of nesting is navigable and
 * two is a maze. Nothing below this line gets its own strip.
 *
 * All the state lives in `tabs.ts`; this only renders it and reports clicks.
 */

import { box, button, each, el, on } from './dom'
import type { TableView } from './state'
import type { TabsState } from './tabs'

export interface TabStripContext {
  tabs: TabsState
  onSelect: (index: number) => void
  /** Double-click on a preview tab: keep it. */
  onPromote: (index: number) => void
  onClose: (index: number) => void
  /** The `+` button — back to the table picker. */
  onNew: () => void
}

export function renderTabStrip(ctx: TabStripContext): HTMLElement {
  const strip = box('tabstrip')
  strip.setAttribute('role', 'tablist')
  each(strip, ctx.tabs.tabs, (_tab, index) => tabNode(ctx, index))
  strip.appendChild(
    button('+', ctx.onNew, {
      class: 'tab-new',
      title: 'open another table',
      attrs: { 'aria-label': 'open another table' },
    }),
  )
  return strip
}

function tabNode(ctx: TabStripContext, index: number): HTMLElement {
  const tab = ctx.tabs.tabs[index]!
  const node = box('tab')
  const active = index === ctx.tabs.active
  node.classList.toggle('active', active)
  // Italic is the whole visual language of a preview tab, borrowed from VS
  // Code because that is where the user learned it.
  node.classList.toggle('preview', tab.preview)
  node.setAttribute('role', 'tab')
  node.setAttribute('aria-selected', active ? 'true' : 'false')

  const label = button(tab.view.table, () => ctx.onSelect(index), {
    class: 'tab-label',
    title: tab.preview ? `${tab.view.table} — preview` : tab.view.table,
  })
  on(label, 'dblclick', () => ctx.onPromote(index))
  node.appendChild(label)
  node.appendChild(closeButton(ctx, index, tab.view.table))

  // Middle-click closes, which is what every browser and every editor has
  // trained people to expect. `auxclick` rather than `mousedown` so a middle
  // *drag* that ends elsewhere does not close anything.
  on(node, 'auxclick', event => {
    if ((event as MouseEvent).button !== 1) return
    event.preventDefault()
    ctx.onClose(index)
  })
  return node
}

function closeButton(
  ctx: TabStripContext,
  index: number,
  table: string,
): HTMLElement {
  return button('×', () => ctx.onClose(index), {
    class: 'tab-close',
    title: `close ${table}`,
    attrs: { 'aria-label': `close ${table}` },
  })
}

// ------------------------------------------------------------ the view switch

const VIEWS: readonly { value: TableView; label: string }[] = [
  { value: 'data', label: 'Data' },
  { value: 'structure', label: 'Structure' },
  { value: 'relations', label: 'Relations' },
]

export interface ViewTabsContext {
  current: TableView
  onSelect: (view: TableView) => void
}

/**
 * Data / Structure / Relations.
 *
 * Structure is separate from data rather than folded into a header panel,
 * which is what DBeaver, DataGrip and Devart all do and what makes "what is
 * this column" answerable without disturbing the grid you were reading.
 */
export function renderViewTabs(ctx: ViewTabsContext): HTMLElement {
  const strip = box('viewtabs')
  strip.setAttribute('role', 'tablist')
  each(strip, VIEWS, entry => {
    const active = entry.value === ctx.current
    const node = button(entry.label, () => ctx.onSelect(entry.value), {
      class: active ? 'viewtab active' : 'viewtab',
      attrs: { role: 'tab', 'aria-selected': active ? 'true' : 'false' },
    })
    return node
  })
  return strip
}

/** The `+` page: no table open, so say what to do rather than showing nothing. */
export function renderNewTabPage(): HTMLElement {
  const node = box('newtab')
  node.appendChild(el('h2', { text: 'No table open' }))
  node.appendChild(
    el('p', {
      class: 'note',
      text: 'Click a table to preview it. Double-click to keep it open.',
    }),
  )
  return node
}
