import {
  ICON_DELETE,
  icon,
  postJson,
  setEmpty,
  setPager,
  setText,
} from './utils'

export let sessionCurrentPage = 1
export let sessionPageSize = 25
export let sessionTotalPages = 1
export let sessionSearchDebounce: number | undefined

function buildSessionRequestParams(): URLSearchParams {
  const searchEl = document.getElementById(
    'session-search-input',
  ) as HTMLInputElement | null
  const sortByEl = document.getElementById(
    'session-sort-by',
  ) as HTMLSelectElement | null
  const sortOrderEl = document.getElementById(
    'session-sort-order',
  ) as HTMLSelectElement | null

  const params = new URLSearchParams({
    page: sessionCurrentPage.toString(),
    pageSize: sessionPageSize.toString(),
    sortBy: sortByEl?.value || 'accessed',
    sortOrder: (sortOrderEl?.value as 'ASC' | 'DESC') || 'DESC',
  })

  const searchValue = searchEl?.value?.trim()
  if (searchValue) params.set('search', searchValue)
  return params
}

function updateSessionsPaginationUI(
  totalRows: number,
  page: number,
  pageSize: number,
  totalPages: number,
) {
  sessionCurrentPage = page
  sessionPageSize = pageSize
  sessionTotalPages = totalPages || 1

  setText('session-rows-meta', `${totalRows} sessions matching filters`)
  setPager(SESSION_PAGER_IDS, page, sessionTotalPages)
}

const SESSION_PAGER_IDS = {
  info: 'session-page-info',
  prev: 'session-page-prev',
  next: 'session-page-next',
}

function resetSessionsUIOnError() {
  sessionCurrentPage = 1
  sessionTotalPages = 1
  setText('session-rows-meta', '0 sessions matching filters')
  setPager(SESSION_PAGER_IDS, 1, 1)
}

const SHOW_LIMIT = 3

function renderKVRows(
  kvSection: HTMLElement,
  entries: [string, any][],
  sId: string,
  showAll: boolean,
) {
  kvSection.innerHTML = ''
  const visible = showAll ? entries : entries.slice(0, SHOW_LIMIT)

  visible.forEach(([k, v]) => {
    const row = document.createElement('div')
    row.style.cssText =
      'display:flex;align-items:center;gap:0.5rem;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:0.375rem;padding:0.3rem 0.6rem;'

    const keyEl = document.createElement('span')
    keyEl.style.cssText =
      'font-size:0.8rem;font-weight:600;color:var(--text-muted);min-width:120px;font-family:monospace;'
    keyEl.innerText = k

    const valEl = document.createElement('span')
    valEl.style.cssText =
      'font-size:0.8rem;color:var(--text);flex:1;font-family:monospace;word-break:break-all;'
    valEl.innerText = is.object(v) ? JSON.stringify(v) : String(v)

    const delBtn = document.createElement('button')
    delBtn.style.cssText =
      'background:none;border:none;cursor:pointer;color:var(--danger);font-size:0.85rem;padding:0.1rem 0.25rem;border-radius:0.25rem;opacity:0.7;transition:opacity 0.15s;'
    delBtn.title = 'Delete key'
    delBtn.innerHTML = icon(ICON_DELETE, '0.95rem')
    delBtn.onmouseenter = () => (delBtn.style.opacity = '1')
    delBtn.onmouseleave = () => (delBtn.style.opacity = '0.7')
    delBtn.onclick = async () => {
      await sessionKeyAction(sId, k, null, true)
      await loadSessions()
    }

    row.appendChild(keyEl)
    row.appendChild(valEl)
    row.appendChild(delBtn)
    kvSection.appendChild(row)
  })

  if (entries.length > SHOW_LIMIT) {
    const toggle = document.createElement('button')
    toggle.style.cssText =
      'font-size:0.75rem;color:var(--text-muted);background:none;border:none;cursor:pointer;text-align:left;padding:0.1rem 0;margin-top:0.1rem;transition:color 0.15s;'
    toggle.innerText = showAll
      ? `▲ Show fewer`
      : `▼ Show all ${entries.length} keys`
    toggle.onmouseenter = () => (toggle.style.color = 'var(--text)')
    toggle.onmouseleave = () => (toggle.style.color = 'var(--text-muted)')
    toggle.onclick = () => renderKVRows(kvSection, entries, sId, !showAll)
    kvSection.appendChild(toggle)
  }

  if (entries.length === 0) {
    const empty = document.createElement('span')
    empty.style.cssText =
      'font-size:0.8rem;color:var(--text-muted);font-style:italic;'
    empty.innerText = 'No data stored in this session.'
    kvSection.appendChild(empty)
  }

}

function renderSessionCard(s: any): HTMLElement {
  const card = document.createElement('div')
  card.className = 'session-card glass-effect'

  const header = document.createElement('div')
  header.className = 'session-card-header'
  header.innerHTML = `<span class="session-id">${escapeHTML(String(s.id))}</span>`

  const revokeBtn = document.createElement('button')
  revokeBtn.className = 'btn btn-secondary btn-danger'
  revokeBtn.style.cssText = 'padding:0.25rem 0.5rem;font-size:0.75rem;'
  revokeBtn.innerText = 'Revoke'
  revokeBtn.onclick = () => revokeSession(s.id)
  header.appendChild(revokeBtn)

  const accessedAt = new Date(s.accessedAt || Date.now())
  const ttl =
    Array.isArray(s.persistKeys) && s.persistKeys.length > 0
      ? 30 * 24 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000
  const expiresAt = new Date((s.accessedAt || Date.now()) + ttl)
  const info = document.createElement('div')
  info.style.cssText =
    'font-size:0.8rem;color:var(--text-muted);display:flex;gap:1.5rem;margin-bottom:0.5rem;'
  info.innerHTML = `
    <span>Last Accessed: <strong style="color:var(--text)">${accessedAt.toLocaleTimeString()}</strong></span>
    <span>Expires: <strong style="color:var(--text)">${expiresAt.toLocaleString()}</strong></span>
  `

  const kvSection = document.createElement('div')
  kvSection.style.cssText =
    'display:flex;flex-direction:column;gap:0.35rem;margin-top:0.5rem;'

  const entries = Object.entries(s.data as Record<string, any>)
  renderKVRows(kvSection, entries, s.id, false)

  card.appendChild(header)
  card.appendChild(info)
  card.appendChild(kvSection)
  return card
}

export async function loadSessions() {
  const container = document.getElementById('session-container')
  if (!container) return
  setEmpty(container, 'Fetching sessions...')

  try {
    const params = buildSessionRequestParams()
    const res = await fetch(`/api/_dashboard/sessions?${params.toString()}`)
    const json = await res.json()

    const rows = Array.isArray(json.data?.rows) ? json.data.rows : []

    if (json.status !== 200 || !json.data || rows.length === 0) {
      setEmpty(container, 'No active sessions found in memory.')
      resetSessionsUIOnError()
      return
    }

    const { totalRows, page, pageSize, totalPages } = json.data
    updateSessionsPaginationUI(totalRows, page, pageSize, totalPages)

    container.innerHTML = ''
    rows.forEach((s: any) => {
      container.appendChild(renderSessionCard(s))
    })
  } catch (_err) {
    setEmpty(container, 'Error loading sessions.')
  }
}

export function queueSessionSearch() {
  if (sessionSearchDebounce) window.clearTimeout(sessionSearchDebounce)
  sessionCurrentPage = 1
  sessionSearchDebounce = window.setTimeout(() => {
    void loadSessions()
  }, 250)
}

export function prevSessionPage() {
  if (sessionCurrentPage <= 1) return
  sessionCurrentPage -= 1
  void loadSessions()
}

export function nextSessionPage() {
  if (sessionCurrentPage >= sessionTotalPages) return
  sessionCurrentPage += 1
  void loadSessions()
}

export function changeSessionPageSize() {
  const pageSizeEl = document.getElementById(
    'session-page-size',
  ) as HTMLSelectElement | null
  if (!pageSizeEl) return

  sessionPageSize = parseInt(pageSizeEl.value, 10)
  sessionCurrentPage = 1
  void loadSessions()
}

export async function sessionKeyAction(
  sessionId: string,
  key: string,
  value: any,
  remove = false,
) {
  try {
    const json = await postJson('/api/_dashboard/sessions/update', {
      id: sessionId,
      key,
      value,
      remove,
    })
    if (json.status !== 200) alert(`Failed: ${json.message}`)
  } catch {
    alert('Connection error.')
  }
}

/*
 * `openSessionKeyEditor` was here, and it could not be opened.
 *
 * It built its overlay with `className = 'modal-overlay'`, and the sheet
 * gives that rule `display: none` - only `.modal-overlay.active` is
 * `display: flex`, and nothing in this package ever added `active`. Checked
 * against a running console: clicking Edit created the element, computed
 * `display: none`, rendered 0x0. So the editor has never opened, and the
 * two buttons that called it did nothing at all.
 *
 * Restoring it would mean deciding what a session-key editor should be,
 * which is a design question rather than a missing class name, and 2.0.0 is
 * not the release to answer it in. What is left on this panel is what works:
 * listing sessions, revoking one, and deleting a key.
 */

export async function revokeSession(sessionId: string) {
  if (!confirm('Are you sure you want to revoke this session?')) return
  try {
    const data = await postJson('/api/_dashboard/sessions/delete', {
      id: sessionId,
    })
    if (data.status === 200) {
      await loadSessions()
    } else {
      alert(`Failed to revoke session: ${data.message}`)
    }
  } catch (_err) {
    alert('Error revoking session.')
  }
}
