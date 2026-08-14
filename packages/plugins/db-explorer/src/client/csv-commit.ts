/**
 * The last step: the bad-row policy, and sending.
 *
 * The interesting part is `commit`. It chunks, and the Cancel button stops
 * **before** the next request rather than aborting one in flight — cancelling
 * mid-flight would leave the user unable to say what landed, and this way the
 * answer is exact and is reported: the chunks that completed are the rows that
 * are in.
 */

import { type ImportResult, importRows } from './api'
import { notify } from './confirm'
import {
  type BadRowPolicy,
  buildRecords,
  chunk,
  type ImportModel,
  issuesOf,
  rejectedCSV,
  setBadRowPolicy,
} from './csv-model'
import { append, box, button, downloadText, el } from './dom'
import type { SchemaColumn, SchemaTable } from './meta'

/** One request per chunk. Well under `policy.ts`'s 50,000 row ceiling. */
const CHUNK = 500

export interface CommitContext {
  table: SchemaTable
  columns: SchemaColumn[]
  reload: () => Promise<void>
}

type Failures = ReturnType<typeof buildRecords>['failures']

export function paintFooter(
  node: HTMLElement,
  ctx: CommitContext,
  model: ImportModel,
  update: (next: ImportModel) => void,
  onClose: () => void,
  stage: HTMLElement,
): void {
  node.replaceChildren()
  const issues = issuesOf(model, ctx.columns)
  const built = buildRecords(model, ctx.columns)

  const policies: { value: BadRowPolicy; label: string }[] = [
    { value: 'skip', label: 'skip bad rows and report' },
    { value: 'stop', label: 'stop at the first bad row' },
    { value: 'all', label: 'all or nothing' },
  ]
  const picker = policyPicker(policies, model, update)

  const count = el('span', {
    class: built.failures.length ? 'row-error' : 'note',
    text: `${built.records.length} rows ready · ${built.failures.length} bad`,
  })

  const go = button(
    'Import',
    () =>
      void commit(stage, ctx, model, built.records, built.failures, onClose),
    { class: 'btn primary' },
  )
  go.disabled = issues.blocking.length > 0 || built.records.length === 0

  append(node, [picker, count, button('Cancel', onClose, { class: 'btn' }), go])
}

function policyPicker(
  policies: readonly { value: BadRowPolicy; label: string }[],
  model: ImportModel,
  update: (next: ImportModel) => void,
): HTMLSelectElement {
  const node = el('select', { class: 'sel' })
  for (const policy of policies) {
    const option = el('option', { text: policy.label })
    option.value = policy.value
    option.selected = policy.value === model.onBadRow
    node.appendChild(option)
  }
  node.addEventListener('change', () =>
    update(setBadRowPolicy(model, node.value as BadRowPolicy)),
  )
  return node
}

async function commit(
  stage: HTMLElement,
  ctx: CommitContext,
  model: ImportModel,
  records: Record<string, unknown>[],
  failures: Failures,
  onClose: () => void,
): Promise<void> {
  stage.replaceChildren()
  const progress = el('p', { text: `0 / ${records.length}` })
  let cancelled = false
  const stop = button(
    'Cancel',
    () => {
      cancelled = true
    },
    { class: 'btn' },
  )
  append(stage, [progress, box('row-bar', stop)])

  // All-or-nothing means one transaction, and one transaction means one
  // request — chunking it would produce N transactions and exactly the partial
  // apply the option exists to rule out.
  const batches = model.onBadRow === 'all' ? [records] : chunk(records, CHUNK)
  const onBadRow = model.onBadRow === 'skip' ? 'skip' : 'stop'

  let inserted = 0
  for (const batch of batches) {
    if (cancelled) break
    const result = await sendBatch(ctx, batch, onBadRow)
    if (!result) break
    inserted += result.inserted
    progress.textContent = `${inserted} / ${records.length}`
  }

  paintDone(stage, ctx, model, failures, {
    cancelled,
    inserted,
    total: records.length,
    onClose,
  })
}

interface DoneFacts {
  cancelled: boolean
  inserted: number
  total: number
  onClose: () => void
}

function paintDone(
  stage: HTMLElement,
  ctx: CommitContext,
  model: ImportModel,
  failures: Failures,
  facts: DoneFacts,
): void {
  const done = button(
    'Done',
    () => {
      void ctx.reload()
      facts.onClose()
    },
    { class: 'btn primary' },
  )
  stage.replaceChildren()
  append(stage, [
    el('p', {
      text: facts.cancelled
        ? `Cancelled — ${facts.inserted} rows landed before it stopped.`
        : `${facts.inserted} rows imported.`,
    }),
    failures.length ? rejectedDownload(model, failures) : null,
    box('row-bar', done),
  ])
}

async function sendBatch(
  ctx: CommitContext,
  rows: Record<string, unknown>[],
  onBadRow: 'stop' | 'skip',
): Promise<ImportResult | null> {
  try {
    return await importRows({ table: ctx.table.name, rows, onBadRow })
  } catch (error) {
    notify((error as Error)?.message ?? 'import failed', 'error')
    return null
  }
}

function rejectedDownload(model: ImportModel, failures: Failures): HTMLElement {
  return button(
    `Download ${failures.length} rejected rows`,
    () => downloadText('rejected.csv', rejectedCSV(model, failures)),
    { class: 'btn' },
  )
}
