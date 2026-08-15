/**
 * The only place this client creates a node.
 *
 * **Nothing here writes `innerHTML`, and `client/safety.test.ts` asserts that
 * no client module does.** Every value the grid renders is a database row —
 * whatever the last writer put there — and the operator's origin owns
 * `/api/_db/rows`, so a string that reached the DOM as markup would be stored
 * XSS to arbitrary row writes. `textContent` is not a style preference; it is
 * the reason this plugin has no XSS surface. The dashboard's grid, which
 * concatenates into `innerHTML` and escapes by hand at each of eight call
 * sites, is the counter-example this one exists not to repeat.
 */

export interface ElOptions {
  class?: string
  text?: string
  title?: string
  id?: string
  /** `aria-*`, `role`, `data-*` — anything set through `setAttribute`. */
  attrs?: Record<string, string | number | boolean | null | undefined>
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.class) node.className = options.class
  if (options.text !== undefined) node.textContent = options.text
  if (options.title !== undefined) node.title = options.title
  if (options.id) node.id = options.id
  applyAttrs(node, options.attrs)
  return node
}

/** Named so the loop is not an inline body inside `el` (see the module rule). */
function applyAttrs(node: HTMLElement, attrs: ElOptions['attrs']): void {
  if (!attrs) return
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    node.setAttribute(name, String(value))
  }
}

export function button(
  label: string,
  onClick: () => void,
  options: ElOptions = {},
): HTMLButtonElement {
  const node = el('button', { ...options, text: label })
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

/** `<div class=…>` with children, the shape most of this UI is made of. */
export function box(cls: string, ...children: (Node | null)[]): HTMLDivElement {
  const node = el('div', { class: cls })
  append(node, children)
  return node
}

export function append(parent: Node, children: (Node | null)[]): void {
  for (const child of children) {
    if (child) parent.appendChild(child)
  }
}

/**
 * Render a list through a named factory.
 *
 * Exists so a caller never writes `for (…) { …twenty lines… }` inline: an
 * inline loop body counts against the enclosing function's cognitive
 * complexity, and a named one does not. The rule is mechanical and this is the
 * tool that makes it cheap to follow.
 */
export function each<T>(
  parent: Node,
  items: readonly T[],
  make: (item: T, index: number) => Node | null,
): void {
  items.forEach((item, index) => {
    const node = make(item, index)
    if (node) parent.appendChild(node)
  })
}

/**
 * A `<table class="grid">` with its heading row already in it.
 *
 * The two lines this replaces — build the table, loop `<th>` into a `<tr>` —
 * had been written out three times, twice in `structure.ts` and once in
 * `csv-preview.ts`. Rows are appended by the caller, because the three differ
 * in what a row is: `structure.ts` has plain text cells, and `csv-preview.ts`
 * puts a checkbox row directly under the headings.
 */
export function gridTable(
  headings: readonly string[],
  cls = 'grid',
): HTMLTableElement {
  const table = el('table', { class: cls })
  const head = el('tr')
  each(head, headings, heading => el('th', { text: heading }))
  table.appendChild(head)
  return table
}

export function clear(node: Node): void {
  ;(node as Element).replaceChildren()
}

/** A pending region: visibly disabled and announced as such. */
export function setBusy(node: HTMLElement, busy: boolean): void {
  node.setAttribute('aria-busy', busy ? 'true' : 'false')
  node.classList.toggle('busy', busy)
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement | Document | Window,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  node.addEventListener(type, handler as EventListener)
}

/** A `<select>` over `{value,label}` options, with the current one selected. */
export function select(
  options: readonly { value: string; label: string }[],
  current: string,
  onChange: (value: string) => void,
  cls = 'sel',
): HTMLSelectElement {
  const node = el('select', { class: cls })
  each(node, options, option => {
    const item = el('option', { text: option.label })
    item.value = option.value
    item.selected = option.value === current
    return item
  })
  node.addEventListener('change', () => onChange(node.value))
  return node
}

/**
 * Hand the browser a file without a server round trip.
 *
 * An object URL rather than a `data:` one: a rejected-rows export of a 50,000
 * row import is megabytes, and Chrome refuses a `data:` navigation past a size
 * that is not documented anywhere.
 */
export function downloadText(
  filename: string,
  text: string,
  type = 'text/csv',
): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = el('a')
  link.href = url
  link.download = filename
  link.click()
  // The object URL owns the blob until it is revoked; the click is synchronous
  // but the download is not, so the revoke waits a turn.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
