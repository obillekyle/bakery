/**
 * One editor per `WidgetKind`, chosen through a record rather than an if-chain.
 *
 * **The null toggle is the point of this module.** Every editor here carries a
 * `∅` button that is *separate from the input*, because SQL NULL and the empty
 * string are different values, the server enforces the difference
 * (`coerce.ts`'s `empty_string` code), and an editor with only a text box can
 * express one of them. The dashboard's editor read every cell as a string, so
 * clearing a field wrote `''` into a numeric column and got `0`.
 */

import { coerceValue } from '../shared/coerce'
import { el, on } from './dom'
import {
  columnKind,
  columnMeta,
  type SchemaColumn,
  type WidgetKind,
} from './meta'

export interface EditorHooks {
  /** Every keystroke's worth: stage into the row buffer, never save. */
  onInput: (value: unknown) => void
  /** Forwarded to the grid's reducer. The editor decides nothing itself. */
  onKey: (event: KeyboardEvent) => void
}

export interface EditorHandle {
  node: HTMLElement
  focus: () => void
  /** The current value, already NULL-aware. Not coerced — that is the caller's. */
  read: () => unknown
}

interface Control {
  /** The focusable element. */
  input: HTMLElement
  read: () => unknown
  /** Put a non-null value back after the null toggle is switched off. */
  write: (value: unknown) => void
}

type Factory = (column: SchemaColumn, value: unknown) => Control

/** `<input type=text>` with the value pre-filled as text, the common case. */
function textControl(_column: SchemaColumn, value: unknown): Control {
  const input = el('input', { class: 'ed' })
  input.type = 'text'
  input.value = value === null || value === undefined ? '' : String(value)
  return {
    input,
    read: () => input.value,
    write: next => {
      input.value = next === null || next === undefined ? '' : String(next)
    },
  }
}

function enumControl(column: SchemaColumn, value: unknown): Control {
  const input = el('select', { class: 'ed' })
  for (const option of column.enum ?? []) {
    const item = el('option', { text: option })
    item.value = option
    item.selected = option === value
    input.appendChild(item)
  }
  return {
    input,
    read: () => input.value,
    write: next => {
      input.value = String(next ?? '')
    },
  }
}

/**
 * A checkbox, and it reads back a real boolean.
 *
 * A driver hands a boolean column back as `1`/`0` on SQLite and MySQL, so the
 * *initial* state has to accept those spellings — but what leaves here is
 * `true`/`false`, which is what `coerceValue` wants and what makes `sameValue`
 * agree that nothing changed when nothing did.
 */
function booleanControl(_column: SchemaColumn, value: unknown): Control {
  const input = el('input', { class: 'ed ed-check' })
  input.type = 'checkbox'
  input.checked =
    value === true || value === 1 || value === '1' || value === 'true'
  return {
    input,
    read: () => input.checked,
    write: next => {
      input.checked = next === true || next === 1
    },
  }
}

/**
 * `datetime-local`, fed and read in the format that control insists on.
 *
 * It refuses an ISO string with a `Z` and refuses one carrying milliseconds, so
 * the value is trimmed to `YYYY-MM-DDTHH:mm` going in and handed back as a full
 * ISO string going out — `coerceValue`'s `date` branch parses either, but the
 * round trip has to be lossless in the direction the user sees.
 */
function dateControl(_column: SchemaColumn, value: unknown): Control {
  const input = el('input', { class: 'ed' })
  input.type = 'datetime-local'
  input.value = toLocalInput(value)
  return {
    input,
    read: () => (input.value ? new Date(input.value).toISOString() : ''),
    write: next => {
      input.value = toLocalInput(next)
    },
  }
}

function toLocalInput(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return ''
  // Local, not UTC: the control shows local time, so feeding it a UTC string
  // shifts every timestamp by the viewer's offset the moment it is opened.
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** A textarea, because a JSON document does not fit on one line. */
function jsonControl(_column: SchemaColumn, value: unknown): Control {
  const input = el('textarea', { class: 'ed ed-json' })
  input.rows = 6
  input.value = jsonText(value)
  return {
    input,
    read: () => input.value,
    write: next => {
      input.value = jsonText(next)
    },
  }
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    // Cyclic or BigInt-bearing. The textarea still needs something to show,
    // and the underlying value is not touched by what is displayed.
    return String(value)
  }
}

const CONTROLS: Record<WidgetKind, Factory> = {
  enum: enumControl,
  boolean: booleanControl,
  date: dateControl,
  json: jsonControl,
  text: textControl,
}

/**
 * An editor for one cell.
 *
 * The wrapper owns three things the control does not: the null toggle, the
 * validity message, and key forwarding. Validation runs `coerceValue` — the
 * same function the server runs — so the message the user sees before sending
 * is the message they would have got back.
 */
export function createEditor(
  column: SchemaColumn,
  value: unknown,
  hooks: EditorHooks,
): EditorHandle {
  const meta = columnMeta(column)
  const wrap = el('div', { class: 'editor' })
  const control = CONTROLS[columnKind(column)](column, value)
  let isNull = value === null || value === undefined
  let lastNonNull: unknown = isNull ? '' : control.read()

  const note = el('div', { class: 'ed-note' })
  const nullToggle = el('button', {
    class: 'ed-null',
    text: '∅',
    title: column.nullable
      ? 'set SQL NULL (not the empty string)'
      : 'this column cannot be NULL',
    attrs: { 'aria-pressed': String(isNull), 'aria-label': 'null' },
  })
  nullToggle.type = 'button'
  nullToggle.disabled = !column.nullable

  const read = () => (isNull ? null : control.read())

  /**
   * `touched` is why the initial paint does not call `onInput`.
   *
   * Two consumers break if merely *opening* an editor counts as input. The
   * insert dialog decides whether to send a column at all from whether it was
   * given a value, so an opening notification would put every column in the
   * record as null and defeat every default in the schema. And a real `DATE`
   * column round trips through `datetime-local` as a different string than the
   * driver returned, so the drawer would mark a row dirty for opening it.
   */
  const refresh = (touched: boolean) => {
    ;(control.input as HTMLInputElement).disabled = isNull
    nullToggle.setAttribute('aria-pressed', String(isNull))
    wrap.classList.toggle('is-null', isNull)
    const current = read()
    const result = coerceValue(current, meta)
    note.textContent = result.ok ? '' : result.message
    wrap.classList.toggle('invalid', !result.ok)
    control.input.setAttribute('aria-invalid', String(!result.ok))
    if (touched) hooks.onInput(current)
  }

  on(nullToggle, 'click', () => {
    if (!isNull) lastNonNull = control.read()
    isNull = !isNull
    if (!isNull) control.write(lastNonNull)
    refresh(true)
    control.input.focus()
  })

  control.input.addEventListener('input', () => refresh(true))
  control.input.addEventListener('change', () => refresh(true))
  control.input.addEventListener('keydown', event => {
    hooks.onKey(event as KeyboardEvent)
  })

  wrap.append(control.input, nullToggle, note)
  // Paints the initial validity only. See the note on `touched`.
  refresh(false)

  return {
    node: wrap,
    focus: () => {
      control.input.focus()
      if (control.input instanceof HTMLInputElement) control.input.select()
    },
    read,
  }
}
