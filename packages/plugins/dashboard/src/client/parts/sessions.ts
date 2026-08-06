import {
  icon,
  ICON_DELETE,
  ICON_EDIT,
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
      'display:flex;align-items:center;gap:0.5rem;background:rgba(255,255,255,0.04);border:1px solid var(--border-color);border-radius:0.375rem;padding:0.3rem 0.6rem;'

    const keyEl = document.createElement('span')
    keyEl.style.cssText =
      'font-size:0.8rem;font-weight:600;color:var(--text-secondary);min-width:120px;font-family:monospace;'
    keyEl.innerText = k

    const valEl = document.createElement('span')
    valEl.style.cssText =
      'font-size:0.8rem;color:var(--text-primary);flex:1;font-family:monospace;word-break:break-all;'
    valEl.innerText = is.object(v) ? JSON.stringify(v) : String(v)

    const editBtn = document.createElement('button')
    editBtn.style.cssText =
      'background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:0.85rem;padding:0.1rem 0.25rem;border-radius:0.25rem;transition:color 0.15s;'
    editBtn.title = 'Edit value'
    editBtn.innerHTML = icon(ICON_EDIT, '0.95rem')
    editBtn.onmouseenter = () => (editBtn.style.color = 'var(--text-primary)')
    editBtn.onmouseleave = () => (editBtn.style.color = 'var(--text-secondary)')
    editBtn.onclick = () =>
      openSessionKeyEditor(
        sId,
        k,
        String(is.object(v) ? JSON.stringify(v) : v),
        () => loadSessions(),
      )

    const delBtn = document.createElement('button')
    delBtn.style.cssText =
      'background:none;border:none;cursor:pointer;color:var(--accent-red);font-size:0.85rem;padding:0.1rem 0.25rem;border-radius:0.25rem;opacity:0.7;transition:opacity 0.15s;'
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
    row.appendChild(editBtn)
    row.appendChild(delBtn)
    kvSection.appendChild(row)
  })

  if (entries.length > SHOW_LIMIT) {
    const toggle = document.createElement('button')
    toggle.style.cssText =
      'font-size:0.75rem;color:var(--text-secondary);background:none;border:none;cursor:pointer;text-align:left;padding:0.1rem 0;margin-top:0.1rem;transition:color 0.15s;'
    toggle.innerText = showAll
      ? `▲ Show fewer`
      : `▼ Show all ${entries.length} keys`
    toggle.onmouseenter = () => (toggle.style.color = 'var(--text-primary)')
    toggle.onmouseleave = () => (toggle.style.color = 'var(--text-secondary)')
    toggle.onclick = () => renderKVRows(kvSection, entries, sId, !showAll)
    kvSection.appendChild(toggle)
  }

  if (entries.length === 0) {
    const empty = document.createElement('span')
    empty.style.cssText =
      'font-size:0.8rem;color:var(--text-secondary);font-style:italic;'
    empty.innerText = 'No data stored in this session.'
    kvSection.appendChild(empty)
  }

  const addRow = document.createElement('div')
  addRow.style.cssText = 'margin-top:0.35rem;'
  const addBtn = document.createElement('button')
  addBtn.className = 'btn btn-secondary'
  addBtn.style.cssText = 'font-size:0.75rem;padding:0.25rem 0.65rem;'
  addBtn.innerText = '+ Add Key'
  addBtn.onclick = () =>
    openSessionKeyEditor(sId, '', '', () => loadSessions(), true)
  addRow.appendChild(addBtn)
  kvSection.appendChild(addRow)
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
    'font-size:0.8rem;color:var(--text-secondary);display:flex;gap:1.5rem;margin-bottom:0.5rem;'
  info.innerHTML = `
    <span>Last Accessed: <strong style="color:var(--text-primary)">${accessedAt.toLocaleTimeString()}</strong></span>
    <span>Expires: <strong style="color:var(--text-primary)">${expiresAt.toLocaleString()}</strong></span>
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

export function openSessionKeyEditor(
  sessionId: string,
  key: string,
  currentValue: string,
  onDone: () => void,
  isNew = false,
) {
  document.getElementById('session-key-editor-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'session-key-editor-overlay'
  overlay.className = 'modal-overlay'
  overlay.style.zIndex = '200'

  const card = document.createElement('div')
  card.className = 'modal-card'
  card.style.maxWidth = '420px'

  // Session keys are written by application code, so their names can carry
  // whatever that code derived them from. Both the heading and the prefilled
  // input reach innerHTML unescaped before this — a stored payload in a
  // session key ran as the dashboard operator the moment they opened it.
  const safeKey = escapeHTML(String(key))
  card.innerHTML = `
    <div class="modal-header">
      <h3>${isNew ? 'Add Session Key' : `Edit Key: <code style="font-size:0.85em;font-weight:400;">${safeKey}</code>`}</h3>
      <button class="modal-close" id="skey-close">×</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:0.75rem;">
      ${
        isNew
          ? `
        <div class="form-group">
          <label class="label">Key</label>
          <input class="input-field" id="skey-key-input" type="text" placeholder="e.g. userId" value="${safeKey}" />
        </div>
      `
          : ''
      }
      <div class="form-group">
        <label class="label">Value <span style="font-size:0.7rem;color:var(--text-secondary);">(string)</span></label>
        <input class="input-field" id="skey-val-input" type="text" placeholder="value" value="${escapeHTML(currentValue)}" />
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="skey-cancel">Cancel</button>
      <button class="btn" id="skey-save">Save</button>
    </div>
  `

  overlay.appendChild(card)
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  document.getElementById('skey-close')!.onclick = close
  document.getElementById('skey-cancel')!.onclick = close
  overlay.addEventListener('click', e => {
    if (e.target === overlay) close()
  })

  document.getElementById('skey-save')!.onclick = async () => {
    const finalKey = isNew
      ? (
          document.getElementById('skey-key-input') as HTMLInputElement
        )?.value?.trim()
      : key
    const val =
      (document.getElementById('skey-val-input') as HTMLInputElement)?.value ??
      ''
    if (!finalKey) {
      alert('Key cannot be empty.')
      return
    }
    await sessionKeyAction(sessionId, finalKey, val)
    close()
    onDone()
  }

  setTimeout(() => {
    const el = document.getElementById(
      isNew ? 'skey-key-input' : 'skey-val-input',
    ) as HTMLInputElement | null
    el?.focus()
    el?.select()
  }, 50)
}

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
