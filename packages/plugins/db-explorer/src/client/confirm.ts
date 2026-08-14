/**
 * Friction proportionate to blast radius, in the spirit of `db:sync`'s DANGER
 * ZONE.
 *
 * `frictionFor` is **pure and tested**; the dialog below is the DOM half. The
 * split matters because the ladder is policy — the thresholds are the answer to
 * "how bad is this if it was a mis-click" — and policy that lives inside a
 * click handler cannot be asserted.
 *
 * **The count fed to this must come from a `dryRun`, never from the page.** A
 * selection of eight checkboxes on a filtered page can delete eight rows or,
 * if the caller built the keys from something wider, rather more; the server's
 * own preview is the only number that is the number.
 */

import { el, on } from './dom'

export type Friction = 'immediate' | 'confirm' | 'typed' | 'refuse'

/**
 * How much ceremony `count` rows deserve.
 *
 * - **≤ 1** — immediate, with an undo. One row is recoverable and a dialog per
 *   row makes the tool unusable for the thing it is for.
 * - **2–100** — a dialog naming the count and what changes.
 * - **101–10 000** — the same, plus typing the table name. At this size the
 *   user is doing something deliberate and should have to prove it.
 * - **> 10 000** — refused. Not a dialog: there is no phrasing of "are you
 *   sure" that makes a ten-thousand-row unreviewed write a good idea, and the
 *   honest answer is to narrow it with a filter.
 */
export function frictionFor(count: number): Friction {
  if (!Number.isFinite(count) || count <= 1) return 'immediate'
  if (count <= 100) return 'confirm'
  if (count <= 10_000) return 'typed'
  return 'refuse'
}

export interface DangerRequest {
  /** What is about to happen, in the user's words: `delete`, `set status`. */
  verb: string
  /** The exact count, from a dry run. */
  count: number
  table: string
  /** A second line: which column, which filter, whatever narrows it. */
  detail?: string
}

export interface DangerOutcome {
  ok: boolean
  /** Present when refused by the ladder rather than by the user. */
  refusal?: string
}

/**
 * Ask, at the level `frictionFor` decided.
 *
 * Returns rather than throws, and returns `{ok: false}` for a dismissal and for
 * a refusal alike — the caller does one check. The refusal carries its reason
 * so the message names the ceiling instead of failing silently.
 */
export async function confirmDanger(
  request: DangerRequest,
): Promise<DangerOutcome> {
  const level = frictionFor(request.count)
  if (level === 'immediate') return { ok: true }
  if (level === 'refuse') {
    return {
      ok: false,
      refusal:
        `${request.count} rows is past the ${(10_000).toLocaleString()} row ` +
        'ceiling for one action — narrow it with a filter',
    }
  }
  const ok = await openDialog(request, level === 'typed')
  return { ok }
}

/**
 * Ask, unconditionally.
 *
 * For the questions that are not about blast radius. Discarding one row of
 * unsaved typing deserves a prompt even though `frictionFor(1)` is `immediate`
 * — the ladder is about how much damage a mis-click does to the *database*,
 * and this one is about work the user has done and the database has not seen.
 */
export async function confirmChoice(request: DangerRequest): Promise<boolean> {
  return await openDialog(request, false)
}

/**
 * A modal `<dialog>`.
 *
 * The native element rather than a hand-rolled overlay: it traps focus, closes
 * on Escape, and is inert to the page behind it without a single line of
 * script. Resolved through a `close` listener so a dismissal by any route —
 * Escape, the backdrop, the button — lands in one place.
 */
function openDialog(request: DangerRequest, typed: boolean): Promise<boolean> {
  const dialog = el('dialog', { class: 'danger' })
  const title = el('h3', {
    text: `${request.verb} ${request.count.toLocaleString()} row${
      request.count === 1 ? '' : 's'
    }`,
  })
  const where = el('p', {
    class: 'note',
    text: `in ${request.table}${request.detail ? ` · ${request.detail}` : ''}`,
  })
  dialog.append(title, where)

  const confirm = el('button', { class: 'btn danger-btn', text: request.verb })
  confirm.type = 'button'

  if (typed) {
    const prompt = el('p', {
      class: 'note',
      text: `Type ${request.table} to confirm.`,
    })
    const input = el('input', { class: 'ed' })
    input.type = 'text'
    input.setAttribute('aria-label', 'table name')
    confirm.disabled = true
    input.addEventListener('input', () => {
      confirm.disabled = input.value.trim() !== request.table
    })
    dialog.append(prompt, input)
  }

  const cancel = el('button', { class: 'btn', text: 'Cancel' })
  cancel.type = 'button'
  const bar = el('div', { class: 'row-bar' })
  bar.append(cancel, confirm)
  dialog.appendChild(bar)

  let accepted = false
  on(confirm, 'click', () => {
    accepted = true
    dialog.close()
  })
  on(cancel, 'click', () => dialog.close())

  // `settle` is narrowed to `(value: boolean) => void` rather than used as the
  // executor's own `resolve`, whose parameter is `boolean | PromiseLike<boolean>`
  // — calling that reads as an unhandled promise to the floating-promise rule.
  let settle: (value: boolean) => void = () => {}
  const answered = new Promise<boolean>(resolve => {
    settle = resolve
  })
  dialog.addEventListener('close', () => {
    dialog.remove()
    settle(accepted)
  })

  document.body.appendChild(dialog)
  dialog.showModal()
  return answered
}

/**
 * A short-lived bar offering to put one thing back.
 *
 * Ten seconds, and the timer is the undo window rather than a toast animation:
 * the action already happened. Returns a disposer so a second action can
 * retire the first offer instead of stacking two.
 */
export function offerUndo(
  message: string,
  undo: () => Promise<void>,
  seconds = 10,
): () => void {
  const bar = el('div', { class: 'undo-bar', attrs: { role: 'status' } })
  bar.appendChild(el('span', { text: message }))

  const action = el('button', { class: 'btn', text: 'Undo' })
  action.type = 'button'
  const remove = () => {
    clearTimeout(timer)
    bar.remove()
  }
  on(action, 'click', () => {
    remove()
    void undo()
  })
  bar.appendChild(action)

  const timer = setTimeout(remove, seconds * 1000)
  document.body.appendChild(bar)
  return remove
}

/** A message that is not a question. Used for a refusal and for a failure. */
export function notify(message: string, kind: 'info' | 'error' = 'info'): void {
  const bar = el('div', {
    class: `undo-bar ${kind}`,
    text: message,
    attrs: { role: kind === 'error' ? 'alert' : 'status' },
  })
  document.body.appendChild(bar)
  setTimeout(() => bar.remove(), 6000)
}
