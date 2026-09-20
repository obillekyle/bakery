/**
 * The CSV import wizard: pick → sniff → map → preview → commit.
 *
 * This file is the composition and nothing else. Each step is its own module:
 * `csv-pick.ts`, `csv-map.ts`, `csv-preview.ts`, `csv-commit.ts`, and
 * everything that *decides* anything is in `csv-model.ts` and is pure. What is
 * left here is one mutable `model` reference and the repaint that follows it.
 *
 * Nothing inspects a `<select>` to work out what the mapping is; the mapping is
 * the model, and every control replaces it wholesale.
 */

import { paintFooter } from './csv-commit'
import {
  paintHead,
  paintMapping,
  paintUnmapped,
  type Reparse,
  reparse,
} from './csv-map'
import { buildModel, type ImportModel } from './csv-model'
import { renderPick } from './csv-pick'
import { paintPreview } from './csv-preview'
import { append, box, el } from './dom'
import type { SchemaColumn, SchemaTable } from './meta'

export interface ImportContext {
  table: SchemaTable
  columns: SchemaColumn[]
  reload: () => Promise<void>
}

export function openImport(ctx: ImportContext): void {
  const dialog = el('dialog', { class: 'danger wide import' })
  dialog.appendChild(el('h3', { text: `Import CSV into ${ctx.table.name}` }))

  const stage = box('import-stage')
  dialog.appendChild(stage)
  dialog.addEventListener('close', () => dialog.remove())
  document.body.appendChild(dialog)
  dialog.showModal()

  const finish = () => dialog.close()
  const onText = (text: string) =>
    renderMapping(stage, ctx, buildModel(text, ctx.columns), finish)
  renderPick(stage, onText, finish)
}

interface Sections {
  head: HTMLElement
  mapping: HTMLElement
  unmapped: HTMLElement
  preview: HTMLElement
  footer: HTMLElement
}

/**
 * Mapping, preview and footer, repainted together.
 *
 * Together rather than selectively, because they are all functions of the one
 * model: the footer's row count, the preview's coercions and the unmapped
 * list's blocking issues all change when a single `<select>` does, and a
 * partial repaint is how two of them end up disagreeing.
 */
function renderMapping(
  stage: HTMLElement,
  ctx: ImportContext,
  initial: ImportModel,
  onClose: () => void,
): void {
  let model = initial
  stage.replaceChildren()

  const sections: Sections = {
    head: box('import-head'),
    mapping: box('import-map'),
    unmapped: box('import-unmapped'),
    preview: box('import-preview'),
    footer: box('row-bar'),
  }
  append(stage, [
    sections.head,
    sections.mapping,
    sections.unmapped,
    sections.preview,
    sections.footer,
  ])

  const update = (next: ImportModel) => {
    model = next
    paint()
  }
  const onReparse = (next: Reparse) => update(reparse(next, ctx.columns))

  const paint = () => {
    paintHead(sections.head, model, onReparse)
    paintMapping(sections.mapping, ctx, model, update)
    paintUnmapped(sections.unmapped, ctx, model)
    paintPreview(sections.preview, ctx.columns, model, update)
    paintFooter(sections.footer, ctx, model, update, onClose, stage)
  }

  paint()
}
