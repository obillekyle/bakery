import {
  addActiveFilter,
  changePageSize,
  clearActiveFilters,
  closeEditModal,
  closeExportMenuIfOutside,
  closeImportModal,
  closeInsertModal,
  deleteTableRow,
  exportToCSV,
  exportToJSON,
  fetchTableData,
  filterTablesList,
  handleCsvFileSelect,
  inspectTable,
  loadSchema,
  nextPage,
  openEditModal,
  openImportModal,
  openInsertModal,
  prevPage,
  removeActiveFilter,
  runQuery,
  selectDatabaseTable,
  startInlineEdit,
  submitEditRow,
  submitImportCsv,
  submitInsertRow,
  toggleExportMenu,
  toggleGridSort,
  truncateCurrentTable,
} from './parts/database'
import { refreshShimmerCache } from './parts/effects'
import { clearLogs, initLogsWebSocket, toggleLogsPlay } from './parts/logs'
import {
  changeSessionPageSize,
  loadSessions,
  nextSessionPage,
  openSessionKeyEditor,
  prevSessionPage,
  queueSessionSearch,
  revokeSession,
  sessionKeyAction,
} from './parts/sessions'
import {
  bindSparklineTooltips,
  changePagesFilter,
  changeTimescale,
  initAnalyticsWebSocket,
  loadStats,
  resetAnalytics,
} from './parts/stats'
import { SegmentedProgress } from './parts/utils'

declare const match: any

function toggleProfileDropdown(event: Event) {
  if (event) event.stopPropagation()
  const menu = document.getElementById('profile-menu')
  if (menu) {
    const isVisible = menu.style.display === 'flex'
    menu.style.display = isVisible ? 'none' : 'flex'
  }
}

function switchTab(tabId: string) {
  const tabBtns = document.querySelectorAll('.tab-btn')
  const panels = document.querySelectorAll('.panel')

  for (const btn of tabBtns) {
    btn.classList.remove('active')

    if (btn.getAttribute('onclick')?.includes(tabId)) {
      btn.classList.add('active')
    }
  }

  for (const panel of panels) {
    panel.classList.toggle('active', panel.id === `panel-${tabId}`)
  }

  match(tabId, {
    sessions: loadSessions,
    database: loadSchema,
    logs: initLogsWebSocket,
    'top-pages': () => loadStats(true),
  })

  refreshShimmerCache()
}

window.addEventListener('click', closeExportMenuIfOutside)

window.addEventListener('click', e => {
  const menu = document.getElementById('profile-menu')
  const trigger = document.querySelector('.profile-trigger-btn')
  if (
    menu &&
    trigger &&
    !trigger.contains(e.target as Node) &&
    !menu.contains(e.target as Node)
  ) {
    menu.style.display = 'none'
  }
})

const w = window as any
w.SegmentedProgress = SegmentedProgress
w.switchTab = switchTab
w.resetAnalytics = resetAnalytics
w.changePagesFilter = changePagesFilter
w.toggleProfileDropdown = toggleProfileDropdown
w.changeTimescale = changeTimescale

w.loadSessions = loadSessions
w.revokeSession = revokeSession
w.queueSessionSearch = queueSessionSearch
w.prevSessionPage = prevSessionPage
w.nextSessionPage = nextSessionPage
w.changeSessionPageSize = changeSessionPageSize
w.sessionKeyAction = sessionKeyAction
w.openSessionKeyEditor = openSessionKeyEditor

w.loadSchema = loadSchema
w.filterTablesList = filterTablesList
w.selectDatabaseTable = selectDatabaseTable
w.fetchTableData = fetchTableData
w.toggleGridSort = toggleGridSort
w.prevPage = prevPage
w.nextPage = nextPage
w.changePageSize = changePageSize
w.startInlineEdit = startInlineEdit
w.addActiveFilter = addActiveFilter
w.removeActiveFilter = removeActiveFilter
w.clearActiveFilters = clearActiveFilters
w.openInsertModal = openInsertModal
w.closeInsertModal = closeInsertModal
w.submitInsertRow = submitInsertRow
w.openEditModal = openEditModal
w.closeEditModal = closeEditModal
w.submitEditRow = submitEditRow
w.openImportModal = openImportModal
w.closeImportModal = closeImportModal
w.handleCsvFileSelect = handleCsvFileSelect
w.submitImportCsv = submitImportCsv
w.toggleExportMenu = toggleExportMenu
w.exportToCSV = exportToCSV
w.exportToJSON = exportToJSON
w.truncateCurrentTable = truncateCurrentTable
w.deleteTableRow = deleteTableRow
w.inspectTable = inspectTable
w.runQuery = runQuery

w.initLogsWebSocket = initLogsWebSocket
w.toggleLogsPlay = toggleLogsPlay
w.clearLogs = clearLogs

if (document.getElementById('panel-stats')) {
  bindSparklineTooltips()
  initAnalyticsWebSocket()
}
