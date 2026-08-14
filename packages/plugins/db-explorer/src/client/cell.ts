/**
 * Keyboard navigation, as a reducer.
 *
 * **Pure, and the reason it exists apart from the grid.** A key handler that
 * reads the DOM to decide what to do can only be tested by building a DOM;
 * this one takes a plain `{key, shiftKey}` and a plain cursor and answers with
 * an action, so `cell.test.ts` pins the whole interaction model — including the
 * two rules that are easy to regress, *Enter commits and moves down* and
 * *blur is not in this table at all* — without happy-dom.
 *
 * **Blur is deliberately absent.** The dashboard saves on blur, so a stray
 * click into another cell is a write, and a three-column edit is three
 * statements with two moments in between where the row is half-updated. Here
 * blur only stages into the row's dirty buffer; the only things that commit are
 * Enter, Tab, and the row's own Save button.
 */

/** The parts of a `KeyboardEvent` this reducer reads. Nothing DOM-shaped. */
export interface KeyEvent {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export interface CellState {
  row: number
  col: number
  /** Rows on the current page. */
  rows: number
  /** Columns in the grid. */
  cols: number
  /** Is an editor open on the focused cell? */
  editing: boolean
  /** May this table be edited at all? Decided once, before first paint. */
  editable: boolean
}

export type CellAction =
  | { type: 'none' }
  | { type: 'move'; row: number; col: number }
  | { type: 'edit' }
  /** Write the editor's value into the row buffer, then move. */
  | { type: 'commit'; move: 'down' | 'right' | 'left' | 'none' }
  /** Throw the editor's value away and restore the cell. */
  | { type: 'cancel' }
  /** Stage SQL NULL — distinct from staging the empty string. */
  | { type: 'null' }

const NONE: CellAction = { type: 'none' }

type Rule = (event: KeyEvent, state: CellState) => CellAction

function clamp(value: number, max: number): number {
  if (value < 0) return 0
  return value > max ? max : value
}

/** A move, or nothing when the cursor is already against that edge. */
function moveBy(
  state: CellState,
  rowStep: number,
  colStep: number,
): CellAction {
  const row = clamp(state.row + rowStep, state.rows - 1)
  const col = clamp(state.col + colStep, state.cols - 1)
  if (row === state.row && col === state.col) return NONE
  return { type: 'move', row, col }
}

function moveTo(state: CellState, row: number, col: number): CellAction {
  const next = {
    row: clamp(row, state.rows - 1),
    col: clamp(col, state.cols - 1),
  }
  if (next.row === state.row && next.col === state.col) return NONE
  return { type: 'move', ...next }
}

/** Only when the table is editable — a read-only grid still navigates. */
function whenEditable(action: CellAction): Rule {
  return (_event, state) => (state.editable ? action : NONE)
}

/**
 * While an editor is open. Four keys, and everything else belongs to the input
 * — a `default` that swallowed keys here would make the editor unable to
 * receive a literal `a`.
 */
const EDITING: Record<string, Rule> = {
  Enter: () => ({ type: 'commit', move: 'down' }),
  Tab: event => ({ type: 'commit', move: event.shiftKey ? 'left' : 'right' }),
  Escape: () => ({ type: 'cancel' }),
}

/** While a cell is merely selected. */
const BROWSING: Record<string, Rule> = {
  ArrowUp: (_e, state) => moveBy(state, -1, 0),
  ArrowDown: (_e, state) => moveBy(state, 1, 0),
  ArrowLeft: (_e, state) => moveBy(state, 0, -1),
  ArrowRight: (_e, state) => moveBy(state, 0, 1),
  Tab: (event, state) => moveBy(state, 0, event.shiftKey ? -1 : 1),
  Home: (event, state) => moveTo(state, event.ctrlKey ? 0 : state.row, 0),
  End: (event, state) =>
    moveTo(state, event.ctrlKey ? state.rows - 1 : state.row, state.cols - 1),
  PageUp: (_e, state) => moveBy(state, -10, 0),
  PageDown: (_e, state) => moveBy(state, 10, 0),
  Enter: whenEditable({ type: 'edit' }),
  F2: whenEditable({ type: 'edit' }),
  // Delete stages NULL rather than clearing to `''`. They are different
  // values, the server enforces the difference, and a grid that offers only
  // one of them cannot express the other.
  Delete: whenEditable({ type: 'null' }),
}

/**
 * One key, one action.
 *
 * An empty page answers `none` for everything: a cursor over zero rows has no
 * valid position, and returning a move to `-1` would be a subscript the caller
 * has to guard at every call site instead of here once.
 */
export function keyOnCell(event: KeyEvent, state: CellState): CellAction {
  if (state.rows <= 0 || state.cols <= 0) return NONE
  const rule = (state.editing ? EDITING : BROWSING)[event.key]
  return rule ? rule(event, state) : NONE
}

/** Where a `commit` leaves the cursor. Same clamping as a bare move. */
export function afterCommit(
  state: CellState,
  move: 'down' | 'right' | 'left' | 'none',
): CellAction {
  if (move === 'down') return moveBy(state, 1, 0)
  if (move === 'right') return moveBy(state, 0, 1)
  if (move === 'left') return moveBy(state, 0, -1)
  return NONE
}
