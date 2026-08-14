import { describe, expect, test } from 'bun:test'
import { afterCommit, type CellState, keyOnCell } from './cell'

/**
 * The interaction model, asserted without a DOM.
 *
 * `keyOnCell` takes a plain `{key}` and a plain cursor, which is the entire
 * reason it is a separate module: a key handler that reached into the grid
 * could only be tested by building one, and the rules below — *Enter commits
 * and moves down*, *Escape reverts*, *Delete means NULL* — are the rules a
 * regression would break silently.
 */

const at = (over: Partial<CellState> = {}): CellState => ({
  row: 1,
  col: 1,
  rows: 3,
  cols: 3,
  editing: false,
  editable: true,
  ...over,
})

describe('browsing', () => {
  test('arrows move one cell', () => {
    expect(keyOnCell({ key: 'ArrowDown' }, at())).toEqual({
      type: 'move',
      row: 2,
      col: 1,
    })
    expect(keyOnCell({ key: 'ArrowLeft' }, at())).toEqual({
      type: 'move',
      row: 1,
      col: 0,
    })
  })

  test('an edge is nothing, not a move to a subscript that does not exist', () => {
    expect(keyOnCell({ key: 'ArrowUp' }, at({ row: 0 }))).toEqual({
      type: 'none',
    })
    expect(keyOnCell({ key: 'ArrowRight' }, at({ col: 2 }))).toEqual({
      type: 'none',
    })
  })

  test('Tab moves right and shift+Tab moves left', () => {
    expect(keyOnCell({ key: 'Tab' }, at())).toEqual({
      type: 'move',
      row: 1,
      col: 2,
    })
    expect(keyOnCell({ key: 'Tab', shiftKey: true }, at())).toEqual({
      type: 'move',
      row: 1,
      col: 0,
    })
  })

  test('ctrl+Home goes to the first cell, End to the last column', () => {
    expect(keyOnCell({ key: 'Home', ctrlKey: true }, at())).toEqual({
      type: 'move',
      row: 0,
      col: 0,
    })
    expect(keyOnCell({ key: 'End' }, at())).toEqual({
      type: 'move',
      row: 1,
      col: 2,
    })
  })

  test('Enter and F2 open an editor', () => {
    expect(keyOnCell({ key: 'Enter' }, at())).toEqual({ type: 'edit' })
    expect(keyOnCell({ key: 'F2' }, at())).toEqual({ type: 'edit' })
  })

  test('Delete stages NULL — the value an empty text box cannot express', () => {
    expect(keyOnCell({ key: 'Delete' }, at())).toEqual({ type: 'null' })
  })

  test('a read-only table still navigates but never edits', () => {
    const readOnly = at({ editable: false })
    expect(keyOnCell({ key: 'ArrowDown' }, readOnly).type).toBe('move')
    expect(keyOnCell({ key: 'Enter' }, readOnly)).toEqual({ type: 'none' })
    expect(keyOnCell({ key: 'Delete' }, readOnly)).toEqual({ type: 'none' })
  })

  test('an empty page answers nothing to everything', () => {
    const empty = at({ rows: 0, cols: 0, row: 0, col: 0 })
    for (const key of ['ArrowDown', 'Enter', 'Tab', 'Delete']) {
      expect(keyOnCell({ key }, empty)).toEqual({ type: 'none' })
    }
  })
})

describe('editing', () => {
  const editing = at({ editing: true })

  test('Enter commits and moves down', () => {
    expect(keyOnCell({ key: 'Enter' }, editing)).toEqual({
      type: 'commit',
      move: 'down',
    })
  })

  test('Tab commits and moves right; shift+Tab commits and moves left', () => {
    expect(keyOnCell({ key: 'Tab' }, editing)).toEqual({
      type: 'commit',
      move: 'right',
    })
    expect(keyOnCell({ key: 'Tab', shiftKey: true }, editing)).toEqual({
      type: 'commit',
      move: 'left',
    })
  })

  test('Escape cancels', () => {
    expect(keyOnCell({ key: 'Escape' }, editing)).toEqual({ type: 'cancel' })
  })

  test('an ordinary character belongs to the input, not to the grid', () => {
    // A `default` arm here would make the editor unable to receive a letter.
    expect(keyOnCell({ key: 'a' }, editing)).toEqual({ type: 'none' })
    expect(keyOnCell({ key: 'ArrowDown' }, editing)).toEqual({ type: 'none' })
  })

  test('blur is not in the table at all', () => {
    // The dashboard saves on blur; this grid stages on blur and commits only
    // on Enter, Tab, or the row's Save. There is no key for it, by design.
    expect(keyOnCell({ key: 'blur' }, editing)).toEqual({ type: 'none' })
  })
})

describe('afterCommit', () => {
  test('the same clamping a bare move gets', () => {
    expect(afterCommit(at({ row: 2 }), 'down')).toEqual({ type: 'none' })
    expect(afterCommit(at(), 'right')).toEqual({ type: 'move', row: 1, col: 2 })
    expect(afterCommit(at(), 'none')).toEqual({ type: 'none' })
  })
})
