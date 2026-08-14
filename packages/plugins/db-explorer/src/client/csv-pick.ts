/**
 * Step one of the import wizard: get the text.
 *
 * A file input and a drop zone, and both end in the same `onText` callback —
 * which is the whole reason this is a module rather than two handlers. Nothing
 * downstream knows or cares which way the file arrived.
 */

import { append, box, button, el, on } from './dom'

export function renderPick(
  stage: HTMLElement,
  onText: (text: string) => void,
  onCancel: () => void,
): void {
  stage.replaceChildren()
  const zone = box('drop')
  zone.appendChild(el('p', { text: 'Drop a CSV here, or choose a file.' }))
  zone.appendChild(fileInput(onText))
  wireDrop(zone, onText)

  append(stage, [
    zone,
    box('row-bar', button('Cancel', onCancel, { class: 'btn' })),
  ])
}

function fileInput(onText: (text: string) => void): HTMLInputElement {
  const input = el('input')
  input.type = 'file'
  input.accept = '.csv,.tsv,.txt,text/csv'
  on(input, 'change', () => {
    const file = input.files?.[0]
    if (file) void file.text().then(onText)
  })
  return input
}

/** Named so the three listeners are not an inline block inside `renderPick`. */
function wireDrop(zone: HTMLElement, onText: (text: string) => void): void {
  on(zone, 'dragover', event => {
    // Without `preventDefault` the browser navigates to the file instead,
    // which loses the dialog and everything in it.
    event.preventDefault()
    zone.classList.add('over')
  })
  on(zone, 'dragleave', () => zone.classList.remove('over'))
  on(zone, 'drop', event => {
    event.preventDefault()
    zone.classList.remove('over')
    const file = (event as DragEvent).dataTransfer?.files?.[0]
    if (file) void file.text().then(onText)
  })
}
