/**
 * The explorer UI: a table list, a row grid with paging and sorting, nothing
 * else. Compiled per request in dev and cached like the dashboard's client;
 * kept deliberately small — this file is the entire browser side.
 */

type SchemaTable = { name: string; rowCount?: number }

type TablePage = {
  rows: Record<string, unknown>[]
  totalRows?: number
  totalPages?: number
}

const app = document.getElementById('app')!

let currentTable = ''
let currentPage = 1
let sortBy: string | null = null
let sortOrder: 'ASC' | 'DESC' = 'ASC'
const PAGE_SIZE = 50

// A ?key= opened in the browser is kept for API calls and scrubbed from the
// URL (and so from history) immediately.
const urlKey = new URLSearchParams(location.search).get('key')
if (urlKey) {
  sessionStorage.setItem('__db_key', urlKey)
  const clean = new URL(location.href)
  clean.searchParams.delete('key')
  history.replaceState(null, '', clean)
}

function keyHeaders(): Record<string, string> {
  const key = sessionStorage.getItem('__db_key')
  return key ? { 'x-db-key': key } : {}
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`/api/_db/${path}`, { headers: keyHeaders() })
  const json = await res.json()
  if (json.status < 200 || json.status >= 300) {
    throw new Error(json.message || `Request failed (${json.status})`)
  }
  return json.data as T
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function renderShell(tables: string[]) {
  app.replaceChildren()

  const side = el('nav', 'side')
  side.appendChild(el('h1', 'brand', 'db explorer'))
  side.appendChild(el('p', 'note', 'read-only'))

  for (const name of tables.sort()) {
    const btn = el('button', 'table-btn', name)
    btn.addEventListener('click', () => {
      currentTable = name
      currentPage = 1
      sortBy = null
      void renderTable()
      side
        .querySelectorAll('.table-btn')
        .forEach(b => b.classList.toggle('active', b.textContent === name))
    })
    side.appendChild(btn)
  }

  const main = el('main', 'main')
  main.id = 'main'
  main.appendChild(el('p', 'note', 'Pick a table.'))

  app.append(side, main)
}

async function renderTable() {
  const main = document.getElementById('main')!
  main.replaceChildren(el('p', 'note', `loading ${currentTable}…`))

  const params = new URLSearchParams({
    tableName: currentTable,
    page: String(currentPage),
    pageSize: String(PAGE_SIZE),
    sortOrder,
  })
  if (sortBy) params.set('sortBy', sortBy)

  let data: TablePage
  try {
    data = await api<TablePage>(`table-data?${params}`)
  } catch (error) {
    main.replaceChildren(el('p', 'error', String(error)))
    return
  }

  const rows = data.rows ?? []
  main.replaceChildren()

  const head = el('header', 'table-head')
  head.appendChild(el('h2', undefined, currentTable))
  const meta = el('span', 'note')
  meta.textContent =
    data.totalRows !== undefined
      ? `${data.totalRows} rows · page ${currentPage}${data.totalPages ? ` / ${data.totalPages}` : ''}`
      : `page ${currentPage}`
  head.appendChild(meta)
  main.appendChild(head)

  if (!rows.length) {
    main.appendChild(el('p', 'note', 'No rows on this page.'))
  } else {
    const cols = Object.keys(rows[0])
    const table = el('table', 'grid')
    const thead = el('thead')
    const headRow = el('tr')
    for (const col of cols) {
      const th = el('th', undefined, col)
      if (col === sortBy) th.textContent += sortOrder === 'ASC' ? ' ↑' : ' ↓'
      // rowid is in the payload but not in the sortable allow-list server-side;
      // offering a header click that silently no-ops reads as a bug.
      if (col === 'rowid') {
        headRow.appendChild(th)
        continue
      }
      th.addEventListener('click', () => {
        sortOrder = sortBy === col && sortOrder === 'ASC' ? 'DESC' : 'ASC'
        sortBy = col
        void renderTable()
      })
      headRow.appendChild(th)
    }
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = el('tbody')
    for (const row of rows) {
      const tr = el('tr')
      for (const col of cols) {
        const value = row[col]
        tr.appendChild(
          el(
            'td',
            value === null ? 'null' : undefined,
            value === null ? 'NULL' : String(value),
          ),
        )
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    const scroller = el('div', 'scroll')
    scroller.appendChild(table)
    main.appendChild(scroller)
  }

  const pager = el('footer', 'pager')
  const prev = el('button', undefined, '← prev') as HTMLButtonElement
  prev.disabled = currentPage <= 1
  prev.addEventListener('click', () => {
    currentPage--
    void renderTable()
  })
  const next = el('button', undefined, 'next →') as HTMLButtonElement
  next.disabled =
    data.totalPages !== undefined
      ? currentPage >= data.totalPages
      : rows.length < PAGE_SIZE
  next.addEventListener('click', () => {
    currentPage++
    void renderTable()
  })
  pager.append(prev, next)
  main.appendChild(pager)
}

async function boot() {
  try {
    // `getSchema` answers a list of table descriptors, not a keyed object.
    const schema = await api<SchemaTable[]>('schema')
    renderShell((schema ?? []).map(t => t.name).filter(Boolean))
  } catch (error) {
    app.replaceChildren(el('p', 'error', String(error)))
  }
}

void boot()
