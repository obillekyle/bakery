import { refreshShimmerCache } from './effects'

declare const is: any

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

export async function loadSchema() {
  const list = document.getElementById('tables-list')
  if (!list) return
  try {
    const res = await fetch('/api/_dashboard/schema')
    const json = await res.json()

    if (json.status !== 200 || !json.data || json.data.length === 0) {
      list.innerHTML =
        '<li class="results-empty" style="padding: 1rem 0;">No tables found</li>'
      const countEl = document.getElementById('tables-count')
      if (countEl) countEl.innerText = '(0)'
      dbSchemaCache = []
      return
    }

    dbSchemaCache = json.data
    list.innerHTML = ''
    const countEl = document.getElementById('tables-count')
    if (countEl) countEl.innerText = `(${json.data.length})`

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
      summary.innerHTML = `
        <div class="table-item-header" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <span class="table-item-name" style="display: inline-flex; align-items: center; gap: 0.25rem; font-weight: 500;">
            <svg   style="font-size: 1rem;" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="currentColor" d="M19 21H5q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21M5 8h14V5H5zm2.5 2H5v9h2.5zm9 0v9H19v-9zm-2 0h-5v9h5z"/></svg>
            <span>${t.name}</span>
          </span>
          <div style="display: flex; align-items: center; gap: 0.35rem;">
            <span class="table-item-rows">${t.rowCount} rows</span>
            <button class="btn btn-secondary" style="padding: 0.15rem 0.4rem; font-size: 0.7rem; border-radius: 0.25rem; display: inline-flex; align-items: center; gap: 0.15rem;" onclick="event.preventDefault(); event.stopPropagation(); selectDatabaseTable('${t.name}')">
              <svg   style="font-size: 0.85rem;" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="currentColor" d="M15.188 14.688Q16.5 13.375 16.5 11.5t-1.312-3.187T12 7T8.813 8.313T7.5 11.5t1.313 3.188T12 16t3.188-1.312m-5.1-1.276Q9.3 12.625 9.3 11.5t.788-1.912T12 8.8t1.913.788t.787 1.912t-.787 1.913T12 14.2t-1.912-.787m-4.738 3.55Q2.35 14.925 1 11.5q1.35-3.425 4.35-5.462T12 4t6.65 2.038T23 11.5q-1.35 3.425-4.35 5.463T12 19t-6.65-2.037m11.838-1.45Q19.55 14.025 20.8 11.5q-1.25-2.525-3.613-4.012T12 6T6.813 7.488T3.2 11.5q1.25 2.525 3.613 4.013T12 17t5.188-1.487"/></svg>
              <span>View</span>
            </button>
          </div>
        </div>
      `
      details.appendChild(summary)

      const info = document.createElement('div')
      info.className = 'table-schema-info'

      let colsHtml = ''
      if (t.columns && t.columns.length > 0) {
        colsHtml = `
          <div class="schema-sec">
            <span class="schema-sec-title">Columns</span>
            <ul class="schema-fields">
              ${t.columns
                .map(
                  (c: any) => `
                <li>
                  ${c.name}
                  <span class="field-type">${c.type || 'NUMERIC'}</span>
                  ${c.pk ? '<span class="field-badge pk">PK</span>' : ''}
                  ${c.notnull ? '<span class="field-badge nn">NN</span>' : ''}
                </li>
              `,
                )
                .join('')}
            </ul>
          </div>
        `
      }

      let idxsHtml = ''
      if (t.indexes && t.indexes.length > 0) {
        idxsHtml = `
          <div class="schema-sec">
            <span class="schema-sec-title">Indexes</span>
            <ul class="schema-fields">
              ${t.indexes
                .map(
                  (i: any) => `
                <li>
                  ${i.name}
                  ${i.unique ? '<span class="field-badge pk">UNIQ</span>' : ''}
                </li>
              `,
                )
                .join('')}
            </ul>
          </div>
        `
      }

      info.innerHTML = `
        ${colsHtml}
        ${idxsHtml}
        <button class="btn-inspect" onclick="inspectTable('${t.name}')">Console Inspect</button>
      `

      details.appendChild(info)
      li.appendChild(details)
      list.appendChild(li)
    })

    setTimeout(refreshShimmerCache, 50)
    if (!currentInspectedTable && json.data.length > 0) {
      selectDatabaseTable(json.data[0].name)
    }
  } catch (_err) {
    list.innerHTML =
      '<li class="results-empty" style="padding: 1rem 0;">Error scanning tables</li>'
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
    titleEl.innerHTML = `
      <svg   style="font-size: 1.25rem;" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="currentColor" d="M19 21H5q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21M5 8h14V5H5zm2.5 2H5v9h2.5zm9 0v9H19v-9zm-2 0h-5v9h5z"/></svg>
      <span>${tableName}</span>
    `
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

function formatTableCell(val: any, col: string, rowidVal: any): string {
  let displayVal = ''
  let cellClass = ''

  if (val === null) {
    displayVal = '<em>null</em>'
    cellClass = 'cell-null'
  } else if (is.object(val)) {
    displayVal = JSON.stringify(val)
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

  return `
    <td 
      class="${cellClass} editable-cell" 
      ondblclick="startInlineEdit(this, '${currentInspectedTable}', ${rowidVal}, '${col}')"
      title="Double-click to inline edit"
    >
      ${displayVal}
    </td>
  `
}

function buildTableHtml(
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
    tableHtml += `<th onclick="toggleGridSort('${col}')" style="cursor: pointer; user-select: none;" ${activeClass}>${col}${arrow}</th>`
  })

  tableHtml += '<th style="width: 120px;">Actions</th></tr></thead><tbody>'

  rows.forEach((row: any) => {
    const rowidVal = row.rowid
    tableHtml += '<tr>'

    if (hasRowid) {
      tableHtml += `<td style="color: var(--text-secondary); font-weight: 500;">${rowidVal}</td>`
    }

    columns.forEach((col: string) => {
      tableHtml += formatTableCell(row[col], col, rowidVal)
    })

    const rowEscapedJson = encodeURIComponent(JSON.stringify(row))
    tableHtml += `
      <td>
        <div style="display: flex; gap: 0.35rem;">
          <button class="btn btn-secondary" style="padding: 0.15rem 0.35rem; font-size: 0.7rem; border-radius: 0.25rem; display: inline-flex; align-items: center; gap: 0.2rem;" onclick="openEditModal('${rowEscapedJson}')">
            <svg   style="font-size: 0.85rem;" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="currentColor" d="M5 19h1.425L16.2 9.225L14.775 7.8L5 17.575zm-2 2v-4.25L16.2 3.575q.3-.275.663-.425t.762-.15t.775.15t.65.45L20.425 5q.3.275.438.65T21 6.4q0 .4-.137.763t-.438.662L7.25 21zM19 6.4L17.6 5zm-3.525 2.125l-.7-.725L16.2 9.225z"/></svg>
            <span>Edit</span>
          </button>
          <button class="btn btn-secondary btn-danger" style="padding: 0.15rem 0.35rem; font-size: 0.7rem; border-radius: 0.25rem; display: inline-flex; align-items: center; gap: 0.2rem;" onclick="deleteTableRow('${currentInspectedTable}', ${rowidVal})">
            <svg   style="font-size: 0.85rem;" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="currentColor" d="M7 21q-.825 0-1.412-.587T5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .825-.587 1.413T17 21zM17 6H7v13h10zM9 17h2V8H9zm4 0h2V8h-2zM7 6v13z"/></svg>
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
  const metaEl = document.getElementById('db-rows-meta')
  if (metaEl) metaEl.innerText = `${totalRows} rows matching filters`

  const countBadge = document.getElementById('table-row-count-badge')
  if (countBadge) countBadge.innerText = `${totalRows} rows`

  const pageInfo = document.getElementById('db-page-info')
  if (pageInfo) pageInfo.innerText = `Page ${page} of ${dbTotalPages}`

  const prevBtn = document.getElementById(
    'btn-page-prev',
  ) as HTMLButtonElement | null
  const nextBtn = document.getElementById(
    'btn-page-next',
  ) as HTMLButtonElement | null
  if (prevBtn) prevBtn.disabled = page <= 1
  if (nextBtn) nextBtn.disabled = page >= dbTotalPages
}

async function executeTableDataFetch() {
  const filterObj: Record<string, string> = {}
  dbActiveFilters.forEach(f => {
    filterObj[f.column] = f.value
  })

  const params = new URLSearchParams({
    tableName: currentInspectedTable || '',
    page: dbCurrentPage.toString(),
    pageSize: dbPageSize.toString(),
    filters: JSON.stringify(filterObj),
  })

  if (dbSortBy) {
    params.append('sortBy', dbSortBy)
    params.append('sortOrder', dbSortOrder)
  }

  const res = await fetch(`/api/_dashboard/table-data?${params.toString()}`)
  return await res.json()
}

function renderFetchedTableData(data: any, gridContainer: HTMLElement | null) {
  const { rows, totalRows, page, totalPages } = data
  dbTotalPages = totalPages || 1

  updatePaginationUI(totalRows, page)

  if (rows.length === 0) {
    if (gridContainer) {
      gridContainer.innerHTML =
        '<div class="results-empty"><span>Empty set returned. Click "Add Row" to insert data.</span></div>'
    }
    return
  }

  const tableSchema = dbSchemaCache.find(t => t.name === currentInspectedTable)
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
  if (gridContainer) {
    gridContainer.innerHTML =
      '<div class="results-empty"><span>Loading data...</span></div>'
  }

  try {
    const json = await executeTableDataFetch()

    if (json.status !== 200) {
      if (gridContainer) {
        gridContainer.innerHTML = `<div class="results-empty" style="color: var(--accent-red);"><span style="display: inline-flex; align-items: center; gap: 0.25rem;"><svg   style="font-size: 1.1rem;" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="currentColor" d="M1 21L12 2l11 19zm3.45-2h15.1L12 6zm8.263-1.287Q13 17.425 13 17t-.288-.712T12 16t-.712.288T11 17t.288.713T12 18t.713-.288M11 15h2v-5h-2zm1-2.5"/></svg>Error: ${json.message}</span></div>`
      }
      return
    }

    renderFetchedTableData(json.data, gridContainer)
  } catch (_err) {
    if (gridContainer) {
      gridContainer.innerHTML =
        '<div class="results-empty" style="color: var(--accent-red);"><span style="display: inline-flex; align-items: center; gap: 0.25rem;"><svg   style="font-size: 1.1rem;" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M1 21L12 2l11 19zm3.45-2h15.1L12 6zm8.263-1.287Q13 17.425 13 17t-.288-.712T12 16t-.712.288T11 17t.288.713T12 18t.713-.288M11 15h2v-5h-2zm1-2.5"/></svg>Network connection error.</span></div>'
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

      const res = await fetch('/api/_dashboard/execute-action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'update-row',
          tableName,
          rowid,
          row: updateData,
        }),
      })
      const json = await res.json()
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

    chip.innerHTML = `
      <span>${f.column} <strong>${opDisplay}</strong> ${['is_null', 'is_not_null'].includes(f.operator) ? '' : `"${f.value}"`}</span>
      <button onclick="removeActiveFilter(${idx})">&times;</button>
    `
    container.appendChild(chip)
  })
}

function buildInsertFormGroup(c: any): HTMLElement {
  const formGroup = document.createElement('div')
  formGroup.className = 'form-group'

  const isBool =
    (c.type || '').toUpperCase() === 'BOOLEAN' ||
    c.name.toLowerCase().includes('status')
  const isNum = ['INTEGER', 'REAL', 'NUMERIC', 'FLOAT'].includes(
    (c.type || '').toUpperCase(),
  )

  const inputHtml = isBool
    ? `<select class="input-field" id="insert-field-${c.name}" name="${c.name}">
          <option value="1">true</option>
          <option value="0">false</option>
        </select>`
    : `<input 
          class="input-field" 
          type="${isNum ? 'number' : 'text'}" 
          id="insert-field-${c.name}" 
          name="${c.name}" 
          placeholder="Enter ${c.name}..."
          ${c.notnull ? 'required' : ''}
        />`

  formGroup.innerHTML = `
    <label class="label" for="insert-field-${c.name}">
      ${c.name} <span class="field-type-sub">${c.type || 'TEXT'}</span>
    </label>
    ${inputHtml}
  `
  return formGroup
}

export function openInsertModal() {
  const modal = document.getElementById('modal-insert')
  const container = document.getElementById('insert-fields-container')
  if (!modal || !container) return

  const tableSchema = dbSchemaCache.find(t => t.name === currentInspectedTable)
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

  const tableSchema = dbSchemaCache.find(t => t.name === currentInspectedTable)
  if (!tableSchema) return

  tableSchema.columns.forEach((c: any) => {
    if (c.pk && (c.type || '').toUpperCase() === 'INTEGER') return

    const val: any = formData.get(c.name)
    if (val === '' || val === null) {
      rowData[c.name] = null
    } else {
      const isNum = ['INTEGER', 'REAL', 'NUMERIC', 'FLOAT'].includes(
        (c.type || '').toUpperCase(),
      )
      if (isNum) {
        rowData[c.name] = Number(val)
      } else {
        rowData[c.name] = val
      }
    }
  })

  try {
    const res = await fetch('/api/_dashboard/execute-action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'insert-row',
        tableName: currentInspectedTable,
        row: rowData,
      }),
    })
    const json = await res.json()
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
  const isReadOnly = c.pk
  const isBool =
    (c.type || '').toUpperCase() === 'BOOLEAN' ||
    c.name.toLowerCase().includes('status')
  const isNum = ['INTEGER', 'REAL', 'NUMERIC', 'FLOAT'].includes(
    (c.type || '').toUpperCase(),
  )

  if (isReadOnly)
    return `<input class="input-field" type="text" id="edit-field-${c.name}" name="${c.name}" value="${escapeHTML(cellVal)}" disabled />`
  if (isBool)
    return `<select class="input-field" id="edit-field-${c.name}" name="${c.name}">
      <option value="1" ${cellVal === 1 ? 'selected' : ''}>true</option>
      <option value="0" ${cellVal === 0 ? 'selected' : ''}>false</option>
    </select>`
  return `<input 
    class="input-field" 
    type="${isNum ? 'number' : 'text'}" 
    id="edit-field-${c.name}" 
    name="${c.name}" 
    value="${cellVal === null ? '' : escapeHTML(cellVal)}"
    ${c.notnull ? 'required' : ''}
  />`
}

function buildEditFormGroup(c: any, row: any): HTMLElement {
  const formGroup = document.createElement('div')
  formGroup.className = 'form-group'
  const cellVal = row[c.name] !== undefined ? row[c.name] : ''
  const readOnlyBadge = c.pk
    ? '<span class="field-badge pk" style="margin-left: 0.25rem;">READ-ONLY</span>'
    : ''
  formGroup.innerHTML = `
    <label class="label" for="edit-field-${c.name}">
      ${c.name} <span class="field-type-sub">${c.type || 'TEXT'}</span> ${readOnlyBadge}
    </label>
    ${buildEditFormInputHtml(c, cellVal)}
  `
  return formGroup
}

export function openEditModal(rowEscapedJson: string) {
  if (!currentInspectedTable) return
  const modal = document.getElementById('modal-edit')
  const container = document.getElementById('edit-fields-container')
  if (!modal || !container) return

  const row = JSON.parse(decodeURIComponent(rowEscapedJson))
  const tableSchema = dbSchemaCache.find(t => t.name === currentInspectedTable)
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

  const tableSchema = dbSchemaCache.find(t => t.name === currentInspectedTable)
  if (!tableSchema) return

  tableSchema.columns.forEach((c: any) => {
    if (c.pk) return

    const val: any = formData.get(c.name)
    if (val === '' || val === null) {
      rowData[c.name] = null
    } else {
      const isNum = ['INTEGER', 'REAL', 'NUMERIC', 'FLOAT'].includes(
        (c.type || '').toUpperCase(),
      )
      if (isNum) {
        rowData[c.name] = Number(val)
      } else {
        rowData[c.name] = val
      }
    }
  })

  try {
    const res = await fetch('/api/_dashboard/execute-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update-row',
        tableName: currentInspectedTable,
        rowid,
        row: rowData,
      }),
    })
    const json = await res.json()
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
    const res = await fetch('/api/_dashboard/execute-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'import-csv',
        tableName: currentInspectedTable,
        csvContent,
      }),
    })
    const json = await res.json()
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

export async function exportToCSV() {
  if (!currentInspectedTable) return
  exportMenuOpen = false
  const menu = document.getElementById('export-menu')
  if (menu) menu.style.display = 'none'

  try {
    const filterObj: Record<string, string> = {}
    dbActiveFilters.forEach(f => {
      filterObj[f.column] = f.value
    })

    const params = new URLSearchParams({
      tableName: currentInspectedTable,
      page: '1',
      pageSize: '100000',
      filters: JSON.stringify(filterObj),
    })
    if (dbSortBy) {
      params.append('sortBy', dbSortBy)
      params.append('sortOrder', dbSortOrder)
    }

    const res = await fetch(`/api/_dashboard/table-data?${params.toString()}`)
    const json = await res.json()

    if (json.status !== 200) {
      alert('Failed to fetch data for export')
      return
    }

    const rows = json.data.rows
    if (rows.length === 0) {
      alert('No data rows to export.')
      return
    }

    const headers = Object.keys(rows[0]).filter(k => k !== 'rowid')
    let csvStr = `${headers.map(h => `"${h.replace(/"/g, '""')}"`).join(',')}\n`

    rows.forEach((row: any) => {
      const line = headers.map(h => {
        let val = row[h]
        if (val === null || val === undefined) return ''
        if (is.object(val)) val = JSON.stringify(val)
        return `"${String(val).replace(/"/g, '""')}"`
      })
      csvStr += `${line.join(',')}\n`
    })

    const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.setAttribute(
      'download',
      `${currentInspectedTable}_export_${new Date().toISOString().slice(0, 10)}.csv`,
    )
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  } catch (_err) {
    alert('Error generating CSV export file')
  }
}

export async function exportToJSON() {
  if (!currentInspectedTable) return
  exportMenuOpen = false
  const menu = document.getElementById('export-menu')
  if (menu) menu.style.display = 'none'

  try {
    const filterObj: Record<string, string> = {}
    dbActiveFilters.forEach(f => {
      filterObj[f.column] = f.value
    })

    const params = new URLSearchParams({
      tableName: currentInspectedTable,
      page: '1',
      pageSize: '100000',
      filters: JSON.stringify(filterObj),
    })
    if (dbSortBy) {
      params.append('sortBy', dbSortBy)
      params.append('sortOrder', dbSortOrder)
    }

    const res = await fetch(`/api/_dashboard/table-data?${params.toString()}`)
    const json = await res.json()

    if (json.status !== 200) {
      alert('Failed to fetch data for export')
      return
    }

    const rows = json.data.rows
    const cleanRows = rows.map((r: any) => {
      const copy = { ...r }
      delete copy.rowid
      return copy
    })

    const blob = new Blob([JSON.stringify(cleanRows, null, 2)], {
      type: 'application/json;charset=utf-8;',
    })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.setAttribute(
      'download',
      `${currentInspectedTable}_export_${new Date().toISOString().slice(0, 10)}.json`,
    )
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
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
    const res = await fetch('/api/_dashboard/execute-action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'truncate', tableName }),
    })
    const json = await res.json()
    if (json.status === 200) {
      await loadSchema()
      dbCurrentPage = 1
      await fetchTableData()

      const sqlBody = document.getElementById('results-body')
      if (sqlBody)
        sqlBody.innerHTML =
          '<div class="results-empty"><span>Table truncated successfully.</span></div>'
      const sqlMeta = document.getElementById('results-meta')
      if (sqlMeta) sqlMeta.innerText = ''
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
    const res = await fetch('/api/_dashboard/execute-action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'delete-row', tableName, rowid }),
    })
    const json = await res.json()
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

function buildResultTableHtml(rows: any[], keys: string[]): string {
  let tableHtml = '<div class="table-wrapper"><table><thead><tr>'
  keys.forEach(k => {
    if (k === 'rowid') {
      tableHtml += '<th style="color: var(--text-secondary);">rowid</th>'
    } else {
      tableHtml += `<th>${k}</th>`
    }
  })

  tableHtml += '</tr></thead><tbody>'

  rows.forEach((row: any) => {
    tableHtml += '<tr>'
    keys.forEach(k => {
      const val = row[k]
      const displayVal =
        val === null
          ? '<em>null</em>'
          : is.object(val)
            ? JSON.stringify(val)
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
    if (resultsBody) {
      resultsBody.innerHTML =
        '<div class="results-empty"><span>Query executed successfully. Empty set returned.</span></div>'
    }
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
  if (resultsBody)
    resultsBody.innerHTML =
      '<div class="results-empty"><span>Executing command...</span></div>'
  if (meta) meta.innerText = ''

  try {
    const res = await fetch('/api/_dashboard/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    })
    const json = await res.json()

    if (json.status !== 200) {
      if (resultsBody) {
        resultsBody.innerHTML = `
          <div class="results-empty" style="color: var(--accent-red);">
            <span style="display: inline-flex; align-items: center; gap: 0.25rem;">
              <iconify-icon icon="lucide:alert-triangle" style="font-size: 1.1rem;"></iconify-icon>
              <span>Query failed: ${json.message}</span>
            </span>
          </div>
        `
      }
      return
    }

    handleQuerySuccess(json.data, resultsBody, meta)
  } catch (_err) {
    if (resultsBody)
      resultsBody.innerHTML =
        '<div class="results-empty" style="color: var(--accent-red);"><span>Connection error.</span></div>'
  }
}
