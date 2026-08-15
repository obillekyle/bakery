/**
 * Steps two and three: how the file was parsed, and where each column goes.
 *
 * Nothing here inspects a `<select>` to work out what the mapping is — the
 * mapping *is* the model, and every control writes a whole new one through
 * `update`. `csv-model.ts` holds all of it and is pure.
 */

import {
  type Assignment,
  buildModel,
  type ImportModel,
  issuesOf,
  reassign,
} from './csv-model'
import { append, box, each, el, on, select } from './dom'
import type { SchemaColumn } from './meta'

const SKIP_VALUE = ' skip'
const CONST_VALUE = ' const'

export interface MapContext {
  columns: SchemaColumn[]
}

export interface Reparse {
  source: string
  delimiter: string
  hasHeader: boolean
}

/**
 * Delimiter and header, both sniffed and both overridable.
 *
 * Re-parsing needs the original text, which the model does not keep — so the
 * source is rebuilt from the parsed rows. That is lossless for the purpose:
 * changing the delimiter after the fact re-splits fields that the wrong
 * delimiter merged, and the merged text is exactly what was in the file.
 */
export function paintHead(
  node: HTMLElement,
  model: ImportModel,
  onReparse: (next: Reparse) => void,
): void {
  node.replaceChildren()
  const source = () => rebuildSource(model)

  const delimiters = [
    { value: ',', label: 'comma ,' },
    { value: ';', label: 'semicolon ;' },
    { value: '\t', label: 'tab' },
    { value: '|', label: 'pipe |' },
  ]
  const picker = select(delimiters, model.delimiter, value =>
    onReparse({
      source: source(),
      delimiter: value,
      hasHeader: model.hasHeader,
    }),
  )

  const header = el('input')
  header.type = 'checkbox'
  header.checked = model.hasHeader
  on(header, 'change', () =>
    onReparse({
      source: source(),
      delimiter: model.delimiter,
      hasHeader: header.checked,
    }),
  )
  const headerLabel = el('label', {
    class: 'note',
    text: ' first row is a header',
  })
  headerLabel.prepend(header)

  append(node, [
    el('span', { class: 'note', text: 'delimiter' }),
    picker,
    headerLabel,
    el('span', { class: 'note', text: summaryText(model) }),
  ])
}

function summaryText(model: ImportModel): string {
  const base = `${model.rows.length} rows · ${model.headers.length} columns`
  return model.ragged.length ? `${base} · ${model.ragged.length} ragged` : base
}

/**
 * The original text, near enough to re-split.
 *
 * Fields are re-quoted with the model's current delimiter so a value that
 * itself contains the *new* delimiter survives the round trip. This is why the
 * wizard can offer a delimiter override at all without holding the file.
 */
function rebuildSource(model: ImportModel): string {
  const quote = (field: string) =>
    /["\n\r]/.test(field) || field.includes(model.delimiter)
      ? `"${field.replace(/"/g, '""')}"`
      : field
  const lines = model.rows.map(row => row.map(quote).join(model.delimiter))
  const head = model.hasHeader
    ? [model.headers.map(quote).join(model.delimiter)]
    : []
  return [...head, ...lines].join('\n')
}

/** A `Reparse` applied. Kept here so `csv.ts` holds no parsing knowledge. */
export function reparse(
  next: Reparse,
  columns: readonly SchemaColumn[],
): ImportModel {
  return buildModel(next.source, columns, {
    delimiter: next.delimiter,
    hasHeader: next.hasHeader,
  })
}

// -------------------------------------------------------------- the mapping

export function paintMapping(
  node: HTMLElement,
  ctx: MapContext,
  model: ImportModel,
  update: (next: ImportModel) => void,
): void {
  node.replaceChildren()
  node.appendChild(el('h4', { text: 'Mapping' }))
  each(node, model.headers, header => mappingRow(ctx, model, header, update))
}

/**
 * One CSV column: its name, three samples, and where it goes.
 *
 * Re-picking a database column already taken **moves** it — `reassign` clears
 * the previous holder — so a duplicate mapping cannot be expressed here at all,
 * rather than being flagged after the fact.
 */
function mappingRow(
  ctx: MapContext,
  model: ImportModel,
  header: string,
  update: (next: ImportModel) => void,
): HTMLElement {
  const assignment = model.assign[header] ?? { kind: 'skip' as const }
  const row = box('map-row')

  const options = [
    { value: SKIP_VALUE, label: '— skip —' },
    { value: CONST_VALUE, label: '— constant… —' },
    ...ctx.columns.map(column => ({
      value: column.name,
      label: `${column.name} · ${column.type}`,
    })),
  ]
  const picker = select(options, currentValue(assignment), value =>
    update(reassign(model, header, assignmentFor(value, assignment))),
  )

  append(row, [
    el('div', { class: 'map-name', text: header }),
    el('div', { class: 'map-samples note', text: sampleText(model, header) }),
    picker,
  ])
  if (assignment.kind === 'constant') {
    append(row, constantControls(ctx, model, header, assignment, update))
  }
  return row
}

function currentValue(assignment: Assignment): string {
  if (assignment.kind === 'column') return assignment.column
  return assignment.kind === 'constant' ? CONST_VALUE : SKIP_VALUE
}

function assignmentFor(value: string, previous: Assignment): Assignment {
  if (value === SKIP_VALUE) return { kind: 'skip' }
  if (value === CONST_VALUE) {
    return {
      kind: 'constant',
      column: previous.kind === 'column' ? previous.column : null,
      text: previous.kind === 'constant' ? previous.text : '',
    }
  }
  return { kind: 'column', column: value }
}

/**
 * A constant needs two things a column mapping does not: which column it feeds,
 * and what the literal is. The CSV column's own values are ignored.
 */
function constantControls(
  ctx: MapContext,
  model: ImportModel,
  header: string,
  assignment: Extract<Assignment, { kind: 'constant' }>,
  update: (next: ImportModel) => void,
): HTMLElement[] {
  const target = select(
    [
      { value: SKIP_VALUE, label: '— into which column —' },
      ...ctx.columns.map(column => ({
        value: column.name,
        label: column.name,
      })),
    ],
    assignment.column ?? SKIP_VALUE,
    value =>
      update(
        reassign(model, header, {
          ...assignment,
          column: value === SKIP_VALUE ? null : value,
        }),
      ),
  )
  const literal = el('input', { class: 'ed' })
  literal.type = 'text'
  literal.value = assignment.text
  literal.placeholder = 'constant value'
  on(literal, 'change', () =>
    update(reassign(model, header, { ...assignment, text: literal.value })),
  )
  return [target, literal]
}

function sampleText(model: ImportModel, header: string): string {
  const index = model.headers.indexOf(header)
  if (index < 0) return ''
  return model.rows
    .slice(0, 3)
    .map(row => row[index] ?? '')
    .map(value => (value === '' ? '␀' : value))
    .join(' · ')
}

/**
 * Database columns nobody feeds, tagged with whether that matters.
 *
 * `blockingIssues` decides `required`; this only renders the answer. A required
 * column names itself here *and* disables the Import button, because a list the
 * user can scroll past is not a block.
 */
export function paintUnmapped(
  node: HTMLElement,
  ctx: MapContext,
  model: ImportModel,
): void {
  node.replaceChildren()
  const issues = issuesOf(model, ctx.columns)

  node.appendChild(el('h4', { text: 'Database columns' }))
  each(node, issues.unmapped, entry => {
    const row = box('unmapped-row')
    row.appendChild(
      el('span', { class: `tag ${entry.status}`, text: entry.status }),
    )
    row.appendChild(el('span', { text: entry.column }))
    return row
  })

  if (issues.unmatched.length) {
    node.appendChild(
      el('p', {
        class: 'note',
        text: `${issues.unmatched.length} CSV columns are not imported: ${issues.unmatched.join(', ')}`,
      }),
    )
  }
  each(node, issues.blocking, issue =>
    el('p', { class: 'row-error', text: issue.message }),
  )
}
