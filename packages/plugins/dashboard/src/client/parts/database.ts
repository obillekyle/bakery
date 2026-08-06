import { refreshShimmerCache } from './effects'
import {
  errorBox,
  executeAction,
  getJson,
  icon,
  ICON_DELETE,
  ICON_EDIT,
  ICON_EYE,
  ICON_TABLE,
  postJson,
  setEmpty,
  setPager,
  setText,
} from './utils'

export let currentInspectedTable: string | null = null
export let dbCurrentPage = 1
export let dbPageSize = 50
export let dbTotalPages = 1
export let dbActiveFilters: Array<{
  column: string
  operator: string
  value: string
}> = []
export let dbSortBy: string | null = null
export let dbSortOrder: 'ASC' | 'DESC' = 'ASC'
export let dbSchemaCache: any[] = []

/**
 * `message` is **escaped here**, the same rule `emptyBox` follows. Both callers
 * happen to pass a literal today, which is exactly the state a helper is in
 * right before someone passes it an error string — markup is not expressible
 * through this at all.
 */
export function schemaListMessage(list: HTMLElement, message: string) {
  list.innerHTML = `<li class="results-empty" style="padding: 1rem 0;">${escapeHTML(message)}</li>`
}

/**
 * A schema section (Columns / Indexes). Identifiers reach `innerHTML`, so they
 * are escaped even though they come from the database rather than a request —
 * the schema is only as trustworthy as whatever created the tables.
 */
function schemaSection(title: string, items: string[]): string {
  if (items.length === 0) return ''
  return (
    `<div class="schema-sec"><span class="schema-sec-title">${title}</span>` +
    `<ul class="schema-fields">${items.join('')}</ul></div>`
  )
}

function buildTableSummary(t: any): string {
  const name = escapeHTML(String(t.name))
  return `
        <div class="table-item-header" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <span class="table-item-name" style="display: inline-flex; align-items: center; gap: 0.25rem; font-weight: 500;">
            ${icon(ICON_TABLE, '1rem')}
            <span>${name}</span>
          </span>
          <div style="display: flex; align-items: center; gap: 0.35rem;">
            <span class="table-item-rows">${escapeHTML(String(t.rowCount))} rows</span>
            <button class="btn btn-secondary" style="padding: 0.15rem 0.4rem; font-size: 0.7rem; border-radius: 0.25rem; display: inline-flex; align-items: center; gap: 0.15rem;" data-table="${name}" onclick="event.preventDefault(); event.stopPropagation(); selectDatabaseTable(this.dataset.table)">
              ${icon(ICON_EYE, '0.85rem')}
              <span>View</span>
            </button>
          </div>
        </div>
      `
}

function buildTableSchemaInfo(t: any): string {
  const cols = (t.columns || []).map(
    (c: any) =>
      `<li>${escapeHTML(String(c.name))}` +
      `<span class="field-type">${escapeHTML(String(c.type || 'NUMERIC'))}</span>` +
      `${c.pk ? '<span class="field-badge pk">PK</span>' : ''}` +
      `${c.notnull ? '<span class="field-badge nn">NN</span>' : ''}</li>`,
  )
  const idxs = (t.indexes || []).map(
    (i: any) =>
      `<li>${escapeHTML(String(i.name))}` +
      `${i.unique ? '<span class="field-badge pk">UNIQ</span>' : ''}</li>`,
  )

  return (
    schemaSection('Columns', cols) +
    schemaSection('Indexes', idxs) +
    `<button class="btn-inspect" data-table="${escapeHTML(String(t.name))}" onclick="inspectTable(this.dataset.table)">Console Inspect</button>`
  )
}

export async function loadSchema() {
  const list = document.getElementById('tables-list')
  if (!list) return
  try {
    const json = await getJson('/api/_dashboard/schema')

    if (json.status !== 200 || !json.data || json.data.length === 0) {
      schemaListMessage(list, 'No tables found')
      setText('tables-count', '(0)')
      dbSchemaCache = []
      return
    }

    dbSchemaCache = json.data
    list.innerHTML = ''
    setText('tables-count', `(${json.data.length})`)

    json.data.forEach((t: any) => {
      const li = document.createElement('li')
      li.className = 'table-group'

      const details = document.createElement('details')
      details.className = 'table-details'

      if (currentInspectedTable === t.name) {
        details.setAttribute('open', '')
      }

      const summary = document.createElement('summary')
      summary.className = 'table-summary'
      summary.innerHTML = buildTableSummary(t)
      details.appendChild(summary)

      const info = document.createElement('div')
      info.className = 'table-schema-info'
      info.innerHTML = buildTableSchemaInfo(t)

      details.appendChild(info)
      li.appendChild(details)
      list.appendChild(li)
    })

    setTimeout(refreshShimmerCache, 50)
    if (!currentInspectedTable && json.data.length > 0) {
      selectDatabaseTable(json.data[0].name)
    }
  } catch (_err) {
    schemaListMessage(list, 'Error scanning tables')
  }
}

export function filterTablesList() {
  const searchInput = document.getElementById(
    'db-table-search',
  ) as HTMLInputElement | null
  const filter = searchInput ? searchInput.value.toLowerCase().trim() : ''
  const listItems = document.querySelectorAll('#tables-list > li.table-group')
  listItems.forEach((item: any) => {
    const nameEl = item.querySelector('.table-item-name')
    if (nameEl) {
      const tableName = nameEl.textContent.trim().toLowerCase()
      if (tableName.includes(filter)) {
        item.style.display = ''
      } else {
        item.style.display = 'none'
      }
    }
  })
}

/** The cached schema entry for the table currently on screen. */
function currentSchema(): any | undefined {
  return dbSchemaCache.find(t => t.name === currentInspectedTable)
}

const NUMERIC_TYPES = ['INTEGER', 'REAL', 'NUMERIC', 'FLOAT']

function isNumericColumn(c: any): boolean {
  return NUMERIC_TYPES.includes((c.type || '').toUpperCase())
}

function isBooleanColumn(c: any): boolean {
  return (
    (c.type || '').toUpperCase() === 'BOOLEAN' ||
    c.name.toLowerCase().includes('status')
  )
}

/** Read one form field back out with the column's declared type applied. */
function readColumnValue(formData: FormData, c: any): any {
  const val: any = formData.get(c.name)
  if (val === '' || val === null) return null
  return isNumericColumn(c) ? Number(val) : val
}

export function selectDatabaseTable(tableName: string) {
  currentInspectedTable = tableName
  dbCurrentPage = 1
  dbActiveFilters = []
  dbSortBy = null
  dbSortOrder = 'ASC'

  const viewCard = document.getElementById('db-browser-view')
  if (viewCard) viewCard.style.display = 'flex'

  const titleEl = document.getElementById('current-table-title')
  if (titleEl) {
    titleEl.innerHTML = `${icon(ICON_TABLE, '1.25rem')}<span>${escapeHTML(String(tableName))}</span>`
  }

  const colSelect = document.getElementById(
    'filter-col-select',
  ) as HTMLSelectElement | null
  if (colSelect) {
    const tableSchema = dbSchemaCache.find(t => t.name === tableName)
    colSelect.innerHTML = '<option value="">-- Choose Column --</option>'

    if (tableSchema?.columns) {
      tableSchema.columns.forEach((c: any) => {
        const opt = document.createElement('option')
        opt.value = c.name
        opt.innerText = `${c.name} (${c.type || 'NUMERIC'})`
        colSelect.appendChild(opt)
      })
    }
  }

  const queryEl = document.getElementById(
    'sql-query',
  ) as HTMLTextAreaElement | null
  if (queryEl) {
    queryEl.value = `SELECT * FROM \`${tableName}\` LIMIT 50;`
  }

  renderFilterChips()
  void fetchTableData()
}

export function formatTableCell(val: any, col: string, rowidVal: any): string {
  let displayVal = ''
  let cellClass = ''

  if (val === null) {
    displayVal = '<em>null</em>'
    cellClass = 'cell-null'
  } else if (is.object(val)) {
    // Escaped like every sibling branch. `is.object([])` is true by a
    // documented decision, so this is the branch any JSON- or array-typed
    // column lands in — and the value is a database row, i.e. whatever the last
    // writer put there. Unescaped it was stored XSS in an origin that owns
    // /api/_dashboard/query.
    displayVal = escapeHTML(JSON.stringify(val))
    cellClass = 'cell-json'
  } else if (
    is.boolean(val) ||
    (col.toLowerCase().includes('status') && (val === 0 || val === 1))
  ) {
    displayVal = val
      ? '<span class="badge badge-success">true</span>'
      : '<span class="badge badge-secondary">false</span>'
    cellClass = 'cell-boolean'
  } else {
    displayVal = escapeHTML(val)
  }

  // Identifiers come from the schema rather than a request, but they are still
  // interpolated into an inline handler — keep them out of the JS string.
  return `
    <td
      class="${cellClass} editable-cell"
      data-table="${escapeHTML(String(currentInspectedTable))}"
      data-col="${escapeHTML(String(col))}"
      ondblclick="startInlineEdit(this, this.dataset.table, ${Number(rowidVal)}, this.dataset.col)"
      title="Double-click to inline edit"
    >
      ${displayVal}
    </td>
  `
}

export function buildTableHtml(
  rows: any[],
  columns: string[],
  hasRowid: boolean,
): string {
  let tableHtml =
    '<div class="table-wrapper"><table class="interactive-grid"><thead><tr>'

  if (hasRowid) {
    tableHtml += `<th style="color: var(--text-secondary); width: 60px;">rowid</th>`
  }

  columns.forEach((col: string) => {
    const isSorted = dbSortBy === col
    const arrow = isSorted ? (dbSortOrder === 'ASC' ? ' ▴' : ' ▾') : ''
    const activeClass = isSorted ? 'class="sorted-column"' : ''
    const safeCol = escapeHTML(String(col))
    tableHtml += `<th data-col="${safeCol}" onclick="toggleGridSort(this.dataset.col)" style="cursor: pointer; user-select: none;" ${activeClass}>${safeCol}${arrow}</th>`
  })

  tableHtml += '<th style="width: 120px;">Actions</th></tr></thead><tbody>'

  rows.forEach((row: any) => {
    const rowidVal = row.rowid
    tableHtml += '<tr>'

    if (hasRowid) {
      // A user table may declare its own `rowid` column, in which case this is
      // a row value rather than SQLite's implicit integer. The two inline
      // handlers below coerce it with `Number()` because they interpolate into
      // JS; here it is displayed, so it is escaped instead of coerced — a
      // non-numeric rowid still renders as itself rather than as NaN.
      tableHtml += `<td style="color: var(--text-secondary); font-weight: 500;">${escapeHTML(String(rowidVal))}</td>`
    }

    columns.forEach((col: string) => {
      tableHtml += formatTableCell(row[col], col, rowidVal)
    })

    // The payload goes in a data attribute, not inside an inline JS string.
    // encodeURIComponent leaves ' ( ) untouched, so a row value like
    // `')-alert(1)-('` used to break straight out of the onclick handler and
    // run as the authenticated admin — a viewed row became full DB access.
    const rowEscapedJson = escapeHTML(encodeURIComponent(JSON.stringify(row)))
    const safeTable = escapeHTML(String(currentInspectedTable))
    tableHtml += `
      <td>
        <div style="display: flex; gap: 0.35rem;">
          <button class="btn btn-secondary" style="padding: 0.15rem 0.35rem; font-size: 0.7rem; border-radius: 0.25rem; display: inline-flex; align-items: center; gap: 0.2rem;" data-row="${rowEscapedJson}" onclick="openEditModal(this.dataset.row)">
            ${icon(ICON_EDIT, '0.85rem')}
            <span>Edit</span>
          </button>
          <button class="btn btn-secondary btn-danger" style="padding: 0.15rem 0.35rem; font-size: 0.7rem; border-radius: 0.25rem; display: inline-flex; align-items: center; gap: 0.2rem;" data-table="${safeTable}" onclick="deleteTableRow(this.dataset.table, ${Number(rowidVal)})">
            ${icon(ICON_DELETE, '0.85rem')}
            <span>Delete</span>
          </button>
        </div>
      </td>
    `

    tableHtml += '</tr>'
  })

  tableHtml += '</tbody></table></div>'
  return tableHtml
}

function updatePaginationUI(totalRows: number, page: number) {
  setText('db-rows-meta', `${totalRows} rows matching filters`)
  setText('table-row-count-badge', `${totalRows} rows`)
  setPager(
    { info: 'db-page-info', prev: 'btn-page-prev', next: 'btn-page-next' },
    page,
    dbTotalPages,
  )
}

/**
 * The query string for `/api/_dashboard/table-data`. The paged grid and both
 * exporters send the same filters and sort — only the page size differs, so
 * one builder serves all three.
 */
function tableDataParams(page: number, pageSize: number): URLSearchParams {
  const filterObj: Record<string, string> = {}
  dbActiveFilters.forEach(f => {
    filterObj[f.column] = f.value
  })

  const params = new URLSearchParams({
    tableName: currentInspectedTable || '',
    page: page.toString(),
    pageSize: pageSize.toString(),
    filters: JSON.stringify(filterObj),
  })

  if (dbSortBy) {
    params.append('sortBy', dbSortBy)
    params.append('sortOrder', dbSortOrder)
  }
  return params
}

function fetchTableRows(page: number, pageSize: number): Promise<any> {
  return getJson(`/api/_dashboard/table-data?${tableDataParams(page, pageSize)}`)
}

function renderFetchedTableData(data: any, gridContainer: HTMLElement | null) {
  const { rows, totalRows, page, totalPages } = data
  dbTotalPages = totalPages || 1

  updatePaginationUI(totalRows, page)

  if (rows.length === 0) {
    setEmpty(
      gridContainer,
      'Empty set returned. Click "Add Row" to insert data.',
    )
    return
  }

  const tableSchema = currentSchema()
  const columns = tableSchema
    ? tableSchema.columns.map((c: any) => c.name)
    : Object.keys(rows[0]).filter(k => k !== 'rowid')

  const tableHtml = buildTableHtml(
    rows,
    columns,
    Object.hasOwn(rows[0], 'rowid'),
  )
  if (gridContainer) gridContainer.innerHTML = tableHtml
}

export async function fetchTableData() {
  if (!currentInspectedTable) return
  const gridContainer = document.getElementById('browser-grid-body')
  setEmpty(gridContainer, 'Loading data...')

  try {
    const json = await fetchTableRows(dbCurrentPage, dbPageSize)

    if (json.status !== 200) {
      // `json.message` is the driver's error text and echoes the filter values
      // that produced it. `errorBox` escapes; escaping again here would render
      // the entities literally.
      if (gridContainer) {
        gridContainer.innerHTML = errorBox(`Error: ${String(json.message)}`)
      }
      return
    }

    renderFetchedTableData(json.data, gridContainer)
  } catch (_err) {
    if (gridContainer) {
      gridContainer.innerHTML = errorBox('Network connection error.')
    }
  }
}

export function toggleGridSort(columnName: string) {
  if (dbSortBy === columnName) {
    dbSortOrder = dbSortOrder === 'ASC' ? 'DESC' : 'ASC'
  } else {
    dbSortBy = columnName
    dbSortOrder = 'ASC'
  }
  void fetchTableData()
}

export function prevPage() {
  if (dbCurrentPage > 1) {
    dbCurrentPage--
    void fetchTableData()
  }
}

export function nextPage() {
  if (dbCurrentPage < dbTotalPages) {
    dbCurrentPage++
    void fetchTableData()
  }
}

export function changePageSize() {
  const sizeEl = document.getElementById(
    'db-page-size',
  ) as HTMLSelectElement | null
  if (sizeEl) {
    dbPageSize = parseInt(sizeEl.value, 10)
    dbCurrentPage = 1
    void fetchTableData()
  }
}

export function startInlineEdit(
  cell: HTMLTableCellElement,
  tableName: string,
  rowid: number,
  column: string,
) {
  if (cell.querySelector('input')) return

  const originalHtml = cell.innerHTML
  let text = cell.innerText

  if (cell.classList.contains('cell-null')) {
    text = ''
  }

  cell.classList.add('editing-active')
  cell.removeAttribute('title')

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'grid-inline-input'
  input.value = text

  cell.innerHTML = ''
  cell.appendChild(input)
  input.focus()

  const finishEdit = async (save: boolean) => {
    cell.classList.remove('editing-active')
    cell.setAttribute('title', 'Double-click to inline edit')

    if (!save || input.value.trim() === text.trim()) {
      cell.innerHTML = originalHtml
      return
    }

    const newVal = input.value.trim()

    try {
      const updateData: Record<string, any> = {}
      updateData[column] =
        newVal === ''
          ? null
          : Number.isNaN(Number(newVal))
            ? newVal
            : Number(newVal)

      const json = await executeAction({
        action: 'update-row',
        tableName,
        rowid,
        row: updateData,
      })
      if (json.status === 200) {
        void fetchTableData()
      } else {
        alert(`Failed to update: ${json.message}`)
        cell.innerHTML = originalHtml
      }
    } catch (_err) {
      alert('Error updating row cell inline')
      cell.innerHTML = originalHtml
    }
  }

  input.onkeydown = e => {
    if (e.key === 'Enter') void finishEdit(true)
    if (e.key === 'Escape') void finishEdit(false)
  }

  input.onblur = () => {
    void finishEdit(true)
  }
}

export function addActiveFilter() {
  const colSelect = document.getElementById(
    'filter-col-select',
  ) as HTMLSelectElement | null
  const opSelect = document.getElementById(
    'filter-op-select',
  ) as HTMLSelectElement | null
  const valInput = document.getElementById(
    'filter-val-input',
  ) as HTMLInputElement | null

  if (!colSelect || !opSelect || !valInput) return

  const column = colSelect.value
  const operator = opSelect.value
  const value = valInput.value.trim()

  if (!column) {
    alert('Please choose a column to filter by.')
    return
  }

  const isNoValOp = ['is_null', 'is_not_null'].includes(operator)
  if (!isNoValOp && value === '') {
    alert('Please enter a filter value.')
    return
  }

  dbActiveFilters.push({
    column,
    operator,
    value: isNoValOp ? operator : value,
  })
  valInput.value = ''

  renderFilterChips()
  dbCurrentPage = 1
  void fetchTableData()
}

export function removeActiveFilter(idx: number) {
  dbActiveFilters.splice(idx, 1)
  renderFilterChips()
  dbCurrentPage = 1
  void fetchTableData()
}

export function clearActiveFilters() {
  dbActiveFilters = []
  renderFilterChips()
  dbCurrentPage = 1
  void fetchTableData()
}

export function renderFilterChips() {
  const container = document.getElementById('active-filters-list')
  if (!container) return
  container.innerHTML = ''

  if (dbActiveFilters.length === 0) {
    container.innerHTML =
      '<span style="font-size: 0.75rem; color: var(--text-secondary); font-style: italic;">No filters applied</span>'
    return
  }

  dbActiveFilters.forEach((f, idx) => {
    const chip = document.createElement('div')
    chip.className = 'filter-chip'

    let opDisplay = f.operator
    if (f.operator === 'like') opDisplay = 'contains'
    else if (f.operator === 'is_null') opDisplay = 'is null'
    else if (f.operator === 'is_not_null') opDisplay = 'is not null'

    // `f.value` is whatever was typed into the filter box; it lands in
    // innerHTML, so it is escaped here.
    const valuePart = ['is_null', 'is_not_null'].includes(f.operator)
      ? ''
      : `"${escapeHTML(String(f.value))}"`
    chip.innerHTML = `
      <span>${escapeHTML(String(f.column))} <strong>${opDisplay}</strong> ${valuePart}</span>
      <button onclick="removeActiveFilter(${idx})">&times;</button>
    `
    container.appendChild(chip)
  })
}

/** The `<label>` shared by both modals — column name plus its declared type. */
function fieldLabel(c: any, forId: string, extra = ''): string {
  return (
    `<label class="label" for="${forId}">${escapeHTML(String(c.name))} ` +
    `<span class="field-type-sub">${escapeHTML(String(c.type || 'TEXT'))}</span>${extra}</label>`
  )
}

function buildInsertFormGroup(c: any): HTMLElement {
  const formGroup = document.createElement('div')
  formGroup.className = 'form-group'

  const name = escapeHTML(String(c.name))
  const fieldId = `insert-field-${name}`

  const inputHtml = isBooleanColumn(c)
    ? `<select class="input-field" id="${fieldId}" name="${name}">
          <option value="1">true</option>
          <option value="0">false</option>
        </select>`
    : `<input
          class="input-field"
          type="${isNumericColumn(c) ? 'number' : 'text'}"
          id="${fieldId}"
          name="${name}"
          placeholder="Enter ${name}..."
          ${c.notnull ? 'required' : ''}
        />`

  formGroup.innerHTML = `${fieldLabel(c, fieldId)}${inputHtml}`
  return formGroup
}

export function openInsertModal() {
  const modal = document.getElementById('modal-insert')
  const container = document.getElementById('insert-fields-container')
  if (!modal || !container) return

  const tableSchema = currentSchema()
  if (!tableSchema) return

  container.innerHTML = ''
  tableSchema.columns.forEach((c: any) => {
    if (c.pk && (c.type || '').toUpperCase() === 'INTEGER') return
    container.appendChild(buildInsertFormGroup(c))
  })

  modal.style.display = 'flex'
}

export function closeInsertModal() {
  const modal = document.getElementById('modal-insert')
  if (modal) modal.style.display = 'none'
}

export async function submitInsertRow(e: Event) {
  e.preventDefault()
  if (!currentInspectedTable) return

  const form = document.getElementById(
    'insert-row-form',
  ) as HTMLFormElement | null
  if (!form) return

  const formData = new FormData(form)
  const rowData: Record<string, any> = {}

  const tableSchema = currentSchema()
  if (!tableSchema) return

  tableSchema.columns.forEach((c: any) => {
    if (c.pk && (c.type || '').toUpperCase() === 'INTEGER') return
    rowData[c.name] = readColumnValue(formData, c)
  })

  try {
    const json = await executeAction({
      action: 'insert-row',
      tableName: currentInspectedTable,
      row: rowData,
    })
    if (json.status === 200) {
      closeInsertModal()
      void loadSchema()
      void fetchTableData()
    } else {
      alert(`Failed to insert row: ${json.message}`)
    }
  } catch (_err) {
    alert('Connection error while inserting row')
  }
}

function buildEditFormInputHtml(c: any, cellVal: any): string {
  const name = escapeHTML(String(c.name))
  const fieldId = `edit-field-${name}`

  if (c.pk)
    return `<input class="input-field" type="text" id="${fieldId}" name="${name}" value="${escapeHTML(cellVal)}" disabled />`
  if (isBooleanColumn(c))
    return `<select class="input-field" id="${fieldId}" name="${name}">
      <option value="1" ${cellVal === 1 ? 'selected' : ''}>true</option>
      <option value="0" ${cellVal === 0 ? 'selected' : ''}>false</option>
    </select>`
  return `<input
    class="input-field"
    type="${isNumericColumn(c) ? 'number' : 'text'}"
    id="${fieldId}"
    name="${name}"
    value="${cellVal === null ? '' : escapeHTML(cellVal)}"
    ${c.notnull ? 'required' : ''}
  />`
}

function buildEditFormGroup(c: any, row: any): HTMLElement {
  const formGroup = document.createElement('div')
  formGroup.className = 'form-group'
  const cellVal = row[c.name] !== undefined ? row[c.name] : ''
  const readOnlyBadge = c.pk
    ? ' <span class="field-badge pk" style="margin-left: 0.25rem;">READ-ONLY</span>'
    : ''
  const fieldId = `edit-field-${escapeHTML(String(c.name))}`
  formGroup.innerHTML =
    fieldLabel(c, fieldId, readOnlyBadge) + buildEditFormInputHtml(c, cellVal)
  return formGroup
}

export function openEditModal(rowEscapedJson: string) {
  if (!currentInspectedTable) return
  const modal = document.getElementById('modal-edit')
  const container = document.getElementById('edit-fields-container')
  if (!modal || !container) return

  const row = JSON.parse(decodeURIComponent(rowEscapedJson))
  const tableSchema = currentSchema()
  if (!tableSchema) return

  const rowidEl = document.getElementById(
    'edit-row-rowid',
  ) as HTMLInputElement | null
  if (rowidEl)
    rowidEl.value =
      row.rowid !== undefined && row.rowid !== null ? String(row.rowid) : ''

  container.innerHTML = ''
  tableSchema.columns.forEach((c: any) => {
    container.appendChild(buildEditFormGroup(c, row))
  })

  modal.style.display = 'flex'
}

export function closeEditModal() {
  const modal = document.getElementById('modal-edit')
  if (modal) modal.style.display = 'none'
}

export async function submitEditRow(e: Event) {
  e.preventDefault()
  if (!currentInspectedTable) return

  const form = document.getElementById(
    'edit-row-form',
  ) as HTMLFormElement | null
  const rowidEl = document.getElementById(
    'edit-row-rowid',
  ) as HTMLInputElement | null
  if (!form || !rowidEl) return

  const rowid = parseInt(rowidEl.value, 10)
  const formData = new FormData(form)
  const rowData: Record<string, any> = {}

  const tableSchema = currentSchema()
  if (!tableSchema) return

  tableSchema.columns.forEach((c: any) => {
    if (c.pk) return
    rowData[c.name] = readColumnValue(formData, c)
  })

  try {
    const json = await executeAction({
      action: 'update-row',
      tableName: currentInspectedTable,
      rowid,
      row: rowData,
    })
    if (json.status === 200) {
      closeEditModal()
      void fetchTableData()
    } else {
      alert(`Failed to update row: ${json.message}`)
    }
  } catch (_err) {
    alert('Connection error while saving edits')
  }
}

export function openImportModal() {
  const modal = document.getElementById('modal-import')
  const txt = document.getElementById(
    'csv-import-textarea',
  ) as HTMLTextAreaElement | null
  const fileInput = document.getElementById(
    'csv-file-input',
  ) as HTMLInputElement | null
  if (txt) txt.value = ''
  if (fileInput) fileInput.value = ''
  if (modal) modal.style.display = 'flex'
}

export function closeImportModal() {
  const modal = document.getElementById('modal-import')
  if (modal) modal.style.display = 'none'
}

export function handleCsvFileSelect(e: Event) {
  const fileInput = e.target as HTMLInputElement
  const file = fileInput.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = evt => {
    const text = evt.target?.result
    const txtArea = document.getElementById(
      'csv-import-textarea',
    ) as HTMLTextAreaElement | null
    if (txtArea && is.string(text)) {
      txtArea.value = text as string
    }
  }
  reader.readAsText(file)
}

export async function submitImportCsv() {
  if (!currentInspectedTable) return
  const txtArea = document.getElementById(
    'csv-import-textarea',
  ) as HTMLTextAreaElement | null
  const csvContent = txtArea ? txtArea.value.trim() : ''

  if (!csvContent) {
    alert('Please paste CSV content or upload a CSV file first.')
    return
  }

  try {
    const json = await executeAction({
      action: 'import-csv',
      tableName: currentInspectedTable,
      csvContent,
    })
    if (json.status === 200) {
      closeImportModal()
      void loadSchema()
      void fetchTableData()
      alert(json.message || 'CSV imported successfully!')
    } else {
      alert(`Import failed: ${json.message}`)
    }
  } catch (_err) {
    alert('Network error while importing CSV')
  }
}

export let exportMenuOpen = false
export function toggleExportMenu() {
  const menu = document.getElementById('export-menu')
  if (!menu) return
  exportMenuOpen = !exportMenuOpen
  menu.style.display = exportMenuOpen ? 'block' : 'none'
}

export function closeExportMenuIfOutside(e: MouseEvent) {
  const menu = document.getElementById('export-menu')
  const trigger = document.querySelector('.export-dropdown-wrapper button')
  if (
    menu &&
    trigger &&
    !trigger.contains(e.target as Node) &&
    !menu.contains(e.target as Node)
  ) {
    exportMenuOpen = false
    menu.style.display = 'none'
  }
}

const EXPORT_PAGE_SIZE = 100000

/** Fetch the full filtered result set both exporters work from. */
async function fetchExportRows(): Promise<any[] | null> {
  const json = await fetchTableRows(1, EXPORT_PAGE_SIZE)
  if (json.status !== 200) {
    alert('Failed to fetch data for export')
    return null
  }
  return json.data.rows
}

function downloadBlob(blob: Blob, extension: string) {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url
  link.setAttribute(
    'download',
    `${currentInspectedTable}_export_${new Date().toISOString().slice(0, 10)}.${extension}`,
  )
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // The object URL pins the blob in memory for the lifetime of the document
  // otherwise; exporting a large table repeatedly leaked one copy per click.
  URL.revokeObjectURL(url)
}

function closeExportMenu() {
  exportMenuOpen = false
  const menu = document.getElementById('export-menu')
  if (menu) menu.style.display = 'none'
}

function toCsv(rows: any[]): string {
  const headers = Object.keys(rows[0]).filter(k => k !== 'rowid')
  const quote = (v: string) => `"${v.replace(/"/g, '""')}"`

  const lines = [headers.map(quote).join(',')]
  for (const row of rows) {
    lines.push(
      headers
        .map(h => {
          const val = row[h]
          if (val === null || val === undefined) return ''
          return quote(String(is.object(val) ? JSON.stringify(val) : val))
        })
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

export async function exportToCSV() {
  if (!currentInspectedTable) return
  closeExportMenu()

  try {
    const rows = await fetchExportRows()
    if (!rows) return
    if (rows.length === 0) {
      alert('No data rows to export.')
      return
    }

    downloadBlob(
      new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8;' }),
      'csv',
    )
  } catch (_err) {
    alert('Error generating CSV export file')
  }
}

export async function exportToJSON() {
  if (!currentInspectedTable) return
  closeExportMenu()

  try {
    const rows = await fetchExportRows()
    if (!rows) return

    const cleanRows = rows.map((r: any) => {
      const copy = { ...r }
      delete copy.rowid
      return copy
    })

    downloadBlob(
      new Blob([JSON.stringify(cleanRows, null, 2)], {
        type: 'application/json;charset=utf-8;',
      }),
      'json',
    )
  } catch (_err) {
    alert('Error generating JSON export file')
  }
}

export async function truncateCurrentTable() {
  if (!currentInspectedTable) return
  await truncateTable(currentInspectedTable)
}

export async function truncateTable(tableName: string) {
  if (
    !confirm(
      'WARNING: Are you absolutely sure you want to truncate the table "' +
        tableName +
        '"? This will delete all rows and reclaim disk space.',
    )
  )
    return
  try {
    const json = await executeAction({ action: 'truncate', tableName })
    if (json.status === 200) {
      await loadSchema()
      dbCurrentPage = 1
      await fetchTableData()

      setEmpty(
        document.getElementById('results-body'),
        'Table truncated successfully.',
      )
      setText('results-meta', '')
    } else {
      alert(`Failed to truncate table: ${json.message}`)
    }
  } catch (_err) {
    alert('Error executing truncate action')
  }
}

export async function deleteTableRow(tableName: string, rowid: number) {
  if (!confirm('Are you sure you want to delete this row?')) return
  try {
    const json = await executeAction({ action: 'delete-row', tableName, rowid })
    if (json.status === 200) {
      void loadSchema()
      void fetchTableData()
    } else {
      alert(`Failed to delete row: ${json.message}`)
    }
  } catch (_err) {
    alert('Error executing delete action')
  }
}

export function inspectTable(tableName: string) {
  selectDatabaseTable(tableName)
}

export function buildResultTableHtml(rows: any[], keys: string[]): string {
  let tableHtml = '<div class="table-wrapper"><table><thead><tr>'
  keys.forEach(k => {
    if (k === 'rowid') {
      tableHtml += '<th style="color: var(--text-secondary);">rowid</th>'
    } else {
      // Column labels come from whatever the console query aliased them to.
      tableHtml += `<th>${escapeHTML(String(k))}</th>`
    }
  })

  tableHtml += '</tr></thead><tbody>'

  rows.forEach((row: any) => {
    tableHtml += '<tr>'
    keys.forEach(k => {
      const val = row[k]
      // Same shape as `formatTableCell`, same reason for the escape: the object
      // branch reaches innerHTML with a database row in it.
      const displayVal =
        val === null
          ? '<em>null</em>'
          : is.object(val)
            ? escapeHTML(JSON.stringify(val))
            : escapeHTML(val)
      tableHtml += `<td>${displayVal}</td>`
    })
    tableHtml += '</tr>'
  })

  tableHtml += '</tbody></table></div>'
  return tableHtml
}

function handleQuerySuccess(
  data: any,
  resultsBody: HTMLElement | null,
  meta: HTMLElement | null,
) {
  const { rows, isSelect, time } = data

  if (meta) {
    meta.innerText = `${isSelect ? `${rows.length} rows returned` : 'Command executed successfully'} in ${time}ms`
  }

  if (rows.length === 0) {
    setEmpty(resultsBody, 'Query executed successfully. Empty set returned.')
    return
  }

  const keys = Object.keys(rows[0])
  const tableHtml = buildResultTableHtml(rows, keys)
  if (resultsBody) resultsBody.innerHTML = tableHtml

  if (!isSelect) {
    void loadSchema()
    if (currentInspectedTable) void fetchTableData()
  }
}

export async function runQuery() {
  const queryEl = document.getElementById(
    'sql-query',
  ) as HTMLTextAreaElement | null
  const sql = queryEl ? queryEl.value.trim() : ''
  if (!sql) return

  const resultsBody = document.getElementById('results-body')
  const meta = document.getElementById('results-meta')
  setEmpty(resultsBody, 'Executing command...')
  if (meta) meta.innerText = ''

  try {
    const json = await postJson('/api/_dashboard/query', { sql })

    if (json.status !== 200) {
      // The engine's error text quotes the submitted SQL back at us. `errorBox`
      // escapes it and supplies its own wrapping span; the `<span>` this used to
      // pass was nesting a second one inside it.
      if (resultsBody) {
        resultsBody.innerHTML = errorBox(`Query failed: ${String(json.message)}`)
      }
      return
    }

    handleQuerySuccess(json.data, resultsBody, meta)
  } catch (_err) {
    setEmpty(resultsBody, 'Connection error.', true)
  }
}
