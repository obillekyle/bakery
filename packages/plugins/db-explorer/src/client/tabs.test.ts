import { describe, expect, test } from 'bun:test'
import { defaultView } from './state'
import {
  activeTab,
  activeView,
  closeTab,
  createTabs,
  decodeTabs,
  encodeTabs,
  openPermanent,
  openPreview,
  promoteActive,
  pruneTabs,
  replaceActiveView,
  selectTab,
  type TabsState,
} from './tabs'

const names = (state: TabsState) => state.tabs.map(tab => tab.view.table)
const previews = (state: TabsState) => state.tabs.map(tab => tab.preview)

/** Three permanent tabs, active on the last — the ordinary starting point. */
function threeOpen(): TabsState {
  let state = createTabs()
  for (const name of ['a', 'b', 'c']) {
    state = openPermanent(state, defaultView(name))
  }
  return state
}

describe('preview semantics', () => {
  test('a single click opens one italic tab', () => {
    const state = openPreview(createTabs(), defaultView('parcels'))
    expect(names(state)).toEqual(['parcels'])
    expect(previews(state)).toEqual([true])
    expect(state.active).toBe(0)
  })

  test('the next single click REPLACES it rather than opening a second', () => {
    // The whole point: browsing twelve tables leaves one tab, not twelve.
    let state = openPreview(createTabs(), defaultView('a'))
    state = openPreview(state, defaultView('b'))
    state = openPreview(state, defaultView('c'))
    expect(names(state)).toEqual(['c'])
    expect(state.active).toBe(0)
  })

  test('a preview tab is replaced in place, not appended after a permanent one', () => {
    let state = openPermanent(createTabs(), defaultView('kept'))
    state = openPreview(state, defaultView('a'))
    state = openPreview(state, defaultView('b'))
    expect(names(state)).toEqual(['kept', 'b'])
    expect(previews(state)).toEqual([false, true])
  })

  test('a double click makes the preview permanent where it stands', () => {
    let state = openPermanent(createTabs(), defaultView('kept'))
    state = openPreview(state, defaultView('a'))
    state = openPermanent(state, defaultView('a'))
    // Promoted, not moved: the strip must not reorder under the cursor that
    // just double-clicked it.
    expect(names(state)).toEqual(['kept', 'a'])
    expect(previews(state)).toEqual([false, false])
    expect(state.active).toBe(1)
  })

  test('an edit promotes the active tab', () => {
    const state = promoteActive(openPreview(createTabs(), defaultView('a')))
    expect(previews(state)).toEqual([false])
  })

  test('promoting is idempotent and harmless with nothing open', () => {
    expect(promoteActive(createTabs())).toEqual(createTabs())
    const once = promoteActive(openPreview(createTabs(), defaultView('a')))
    expect(promoteActive(once)).toEqual(once)
  })

  test('a permanent tab survives the next single click on another table', () => {
    let state = openPermanent(createTabs(), defaultView('a'))
    state = openPreview(state, defaultView('b'))
    expect(names(state)).toEqual(['a', 'b'])
  })
})

describe('reopening keeps what the tab was left on', () => {
  test('clicking an open table selects it and does not reset its view', () => {
    // This is the property tabs exist for. Reopening from the sidebar must not
    // throw away the page, sort and filters the user left the tab on.
    let state = openPermanent(createTabs(), defaultView('parcels'))
    state = replaceActiveView(state, {
      ...defaultView('parcels'),
      page: 4,
      sortBy: 'courier',
      filters: [{ column: 'courier', op: 'eq', value: 'dhl' }],
    })
    state = openPermanent(state, defaultView('other'))

    const back = openPreview(state, defaultView('parcels'))
    expect(back.active).toBe(0)
    expect(activeView(back)?.page).toBe(4)
    expect(activeView(back)?.sortBy).toBe('courier')
    expect(activeView(back)?.filters).toHaveLength(1)
  })

  test('a single click on an open preview tab does not un-preview it', () => {
    let state = openPreview(createTabs(), defaultView('a'))
    state = openPreview(state, defaultView('a'))
    expect(previews(state)).toEqual([true])
  })

  test('paging inside a preview tab does not promote it', () => {
    // Looking harder at a table is still looking. Only an edit promotes.
    let state = openPreview(createTabs(), defaultView('a'))
    state = replaceActiveView(state, { ...defaultView('a'), page: 3 })
    expect(previews(state)).toEqual([true])
    expect(activeView(state)?.page).toBe(3)
  })
})

describe('closing', () => {
  test('closing the active tab activates the one that slid into its slot', () => {
    const state = closeTab(selectTab(threeOpen(), 1), 1)
    expect(names(state)).toEqual(['a', 'c'])
    expect(activeView(state)?.table).toBe('c')
  })

  test('closing the last tab falls back to the new last one', () => {
    const state = closeTab(selectTab(threeOpen(), 2), 2)
    expect(names(state)).toEqual(['a', 'b'])
    expect(activeView(state)?.table).toBe('b')
  })

  test('closing left of the active one keeps the SAME tab selected', () => {
    // The naive implementation leaves `active` alone and silently switches the
    // user to a different table.
    const state = closeTab(selectTab(threeOpen(), 2), 0)
    expect(names(state)).toEqual(['b', 'c'])
    expect(activeView(state)?.table).toBe('c')
  })

  test('closing right of the active one leaves the selection alone', () => {
    const state = closeTab(selectTab(threeOpen(), 0), 2)
    expect(activeView(state)?.table).toBe('a')
    expect(state.active).toBe(0)
  })

  test('closing the only tab leaves the new-tab page', () => {
    const state = closeTab(openPermanent(createTabs(), defaultView('a')), 0)
    expect(state.tabs).toEqual([])
    expect(state.active).toBe(-1)
    expect(activeTab(state)).toBeNull()
  })

  test('an out-of-range index is a no-op rather than a corrupted strip', () => {
    const state = threeOpen()
    expect(closeTab(state, 9)).toEqual(state)
    expect(closeTab(state, -1)).toEqual(state)
    expect(selectTab(state, 9)).toEqual(state)
  })
})

describe('the strip in the URL', () => {
  test('open tabs and the active one round trip', () => {
    let state = threeOpen()
    state = selectTab(state, 1)
    expect(decodeTabs(`#${encodeTabs(state)}`)).toEqual(state)
  })

  test('a tab keeps its own page, sort and filters across the round trip', () => {
    let state = openPermanent(createTabs(), defaultView('a'))
    state = replaceActiveView(state, {
      ...defaultView('a'),
      view: 'structure',
      page: 7,
      sortBy: 'x',
      sortOrder: 'DESC',
      filters: [{ column: 'x', op: 'gte', value: '3' }],
    })
    state = openPermanent(state, defaultView('b'))
    expect(decodeTabs(encodeTabs(state))).toEqual(state)
  })

  test('which tab is the preview survives too', () => {
    let state = openPermanent(createTabs(), defaultView('a'))
    state = openPreview(state, defaultView('b'))
    const back = decodeTabs(encodeTabs(state))
    expect(previews(back)).toEqual([false, true])
  })

  test('a pre-tabs link opens as one permanent tab', () => {
    // `#t=parcels&p=2` is in bookmarks and chat logs; rendering nothing for it
    // would be the most visible possible regression.
    const state = decodeTabs('#t=parcels&p=2')
    expect(names(state)).toEqual(['parcels'])
    expect(previews(state)).toEqual([false])
    expect(activeView(state)?.page).toBe(2)
  })

  test('an empty hash is the new-tab page', () => {
    expect(decodeTabs('')).toEqual(createTabs())
    expect(decodeTabs('#')).toEqual(createTabs())
  })

  test('a hand-edited active index is clamped rather than trusted', () => {
    const encoded = encodeTabs(threeOpen()).replace(/a=\d+/, 'a=99')
    expect(decodeTabs(encoded).active).toBe(2)
    const negative = encodeTabs(threeOpen()).replace(/a=\d+/, 'a=-3')
    expect(decodeTabs(negative).active).toBe(2)
  })

  test('a hand-edited preview index out of range marks nothing', () => {
    const encoded = `${encodeTabs(threeOpen())}&w=9`
    expect(previews(decodeTabs(encoded))).toEqual([false, false, false])
  })
})

describe('pruning tables that are gone', () => {
  test('a tab naming a dropped table is removed', () => {
    const state = pruneTabs(threeOpen(), new Set(['a', 'c']))
    expect(names(state)).toEqual(['a', 'c'])
  })

  test('the same tab stays selected when something before it is pruned', () => {
    const state = pruneTabs(selectTab(threeOpen(), 2), new Set(['b', 'c']))
    expect(activeView(state)?.table).toBe('c')
  })

  test('pruning the active tab falls back to the last survivor', () => {
    const state = pruneTabs(selectTab(threeOpen(), 1), new Set(['a', 'c']))
    expect(activeView(state)?.table).toBe('c')
  })

  test('nothing to prune returns the same object', () => {
    const state = threeOpen()
    expect(pruneTabs(state, new Set(['a', 'b', 'c']))).toBe(state)
  })

  test('pruning everything leaves the new-tab page', () => {
    const state = pruneTabs(threeOpen(), new Set<string>())
    expect(state.tabs).toEqual([])
    expect(state.active).toBe(-1)
  })
})

describe('replaceActiveView with nothing open', () => {
  test('opens a permanent tab rather than dropping the navigation', () => {
    const state = replaceActiveView(createTabs(), defaultView('a'))
    expect(names(state)).toEqual(['a'])
    expect(previews(state)).toEqual([false])
  })
})
