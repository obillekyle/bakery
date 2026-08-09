/**
 * The interactive half of `bun create bakery`, written from scratch.
 *
 * Every prompt library worth using is a dependency, and this package declares
 * **none** on purpose — `bun create` downloads it standalone, so anything it
 * pulls in is a download the user waits through before seeing a single file.
 * Two prompts is less code than justifying the exception.
 *
 * The key handling is separated from the terminal I/O for the same reason
 * `template.ts` is separated from `index.ts`: a state machine can be tested
 * exhaustively without a TTY, and the driver below is then thin enough to read
 * in one sitting.
 */

const ESC = '\x1b'
const KEY = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  enter: '\r',
  enterLf: '\n',
  space: ' ',
  ctrlC: '\x03',
  ctrlD: '\x04',
} as const

export type Choice = { id: string; label: string; hint?: string }

export type MultiselectState = {
  choices: Choice[]
  cursor: number
  selected: Set<string>
}

export type KeyResult =
  | { kind: 'update'; state: MultiselectState }
  | { kind: 'submit'; state: MultiselectState }
  | { kind: 'cancel' }

/**
 * Apply one keypress to a multiselect.
 *
 * Pure, and it returns a *new* set rather than mutating: the renderer is called
 * with the result, and a mutated set would make a stale render indistinguishable
 * from a fresh one while debugging.
 *
 * The cursor wraps. `a` toggles everything, which is the shortcut people reach
 * for when the answer is "all of them" and is cheaper to support than to
 * explain the absence of.
 */
export function applyKey(state: MultiselectState, key: string): KeyResult {
  if (key === KEY.ctrlC || key === KEY.ctrlD) return { kind: 'cancel' }

  const total = state.choices.length
  const next = (cursor: number, selected: Set<string>): KeyResult => ({
    kind: 'update',
    state: { ...state, cursor, selected },
  })

  if (key === KEY.up) {
    return next((state.cursor - 1 + total) % total, state.selected)
  }
  if (key === KEY.down) {
    return next((state.cursor + 1) % total, state.selected)
  }
  if (key === KEY.space) {
    const selected = new Set(state.selected)
    const id = state.choices[state.cursor]!.id
    if (!selected.delete(id)) selected.add(id)
    return next(state.cursor, selected)
  }
  if (key === 'a' || key === 'A') {
    const all = state.selected.size === total
    return next(
      state.cursor,
      all ? new Set() : new Set(state.choices.map(c => c.id)),
    )
  }
  if (key === KEY.enter || key === KEY.enterLf) {
    return { kind: 'submit', state }
  }
  return { kind: 'update', state }
}

/** Apply one keypress to a yes/no. `null` means "not answered yet". */
export function applyConfirmKey(
  key: string,
  fallback: boolean,
):
  | { kind: 'answer'; value: boolean }
  | { kind: 'cancel' }
  | { kind: 'ignore' } {
  if (key === KEY.ctrlC || key === KEY.ctrlD) return { kind: 'cancel' }
  if (key === 'y' || key === 'Y') return { kind: 'answer', value: true }
  if (key === 'n' || key === 'N') return { kind: 'answer', value: false }
  if (key === KEY.enter || key === KEY.enterLf) {
    return { kind: 'answer', value: fallback }
  }
  return { kind: 'ignore' }
}

const DIM = `${ESC}[2m`
const CYAN = `${ESC}[36m`
const GREEN = `${ESC}[32m`
const RESET = `${ESC}[0m`

export function renderMultiselect(
  question: string,
  state: MultiselectState,
): string {
  const lines = state.choices.map((choice, i) => {
    const here = i === state.cursor
    const box = state.selected.has(choice.id) ? `${GREEN}◉${RESET}` : '◯'
    const pointer = here ? `${CYAN}❯${RESET}` : ' '
    const label = here ? `${CYAN}${choice.label}${RESET}` : choice.label
    const hint = choice.hint ? ` ${DIM}${choice.hint}${RESET}` : ''
    return `${pointer} ${box} ${label}${hint}`
  })

  return (
    `${GREEN}?${RESET} ${question}` +
    ` ${DIM}(↑↓ move, space toggle, a all, enter confirm)${RESET}\n` +
    `${lines.join('\n')}\n`
  )
}

/** True when both ends of the terminal are real, which is what raw mode needs. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

function write(text: string): void {
  process.stdout.write(text)
}

/** Move the cursor up `n` lines and clear from there down. */
function clearLines(n: number): void {
  if (n > 0) write(`${ESC}[${n}A`)
  write(`${ESC}[0J`)
}

async function* keypresses(): AsyncGenerator<string> {
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  try {
    for await (const chunk of process.stdin) {
      // A single read can carry a whole escape sequence, and on a fast paste it
      // can carry several keys at once. Arrow keys are the only multi-byte
      // sequence handled, so they are matched first and the rest is yielded
      // character by character.
      const text = Buffer.from(chunk).toString('utf8')
      let i = 0
      while (i < text.length) {
        if (text.startsWith(`${ESC}[`, i) && i + 2 < text.length) {
          yield text.slice(i, i + 3)
          i += 3
          continue
        }
        yield text[i]!
        i += 1
      }
    }
  } finally {
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
  }
}

export async function confirm(
  question: string,
  fallback: boolean,
): Promise<boolean | null> {
  const suffix = fallback ? 'Y/n' : 'y/N'
  write(`${GREEN}?${RESET} ${question} ${DIM}(${suffix})${RESET} `)

  for await (const key of keypresses()) {
    const result = applyConfirmKey(key, fallback)
    if (result.kind === 'ignore') continue
    if (result.kind === 'cancel') {
      write('\n')
      return null
    }
    write(`${CYAN}${result.value ? 'yes' : 'no'}${RESET}\n`)
    return result.value
  }
  return null
}

/** Returns the chosen ids, or `null` if the user cancelled. */
export async function multiselect(
  question: string,
  choices: Choice[],
): Promise<string[] | null> {
  let state: MultiselectState = { choices, cursor: 0, selected: new Set() }

  let frame = renderMultiselect(question, state)
  write(`${ESC}[?25l${frame}`) // hide the cursor while redrawing

  try {
    for await (const key of keypresses()) {
      const result = applyKey(state, key)
      if (result.kind === 'cancel') {
        clearLines(frame.split('\n').length - 1)
        return null
      }

      const previous = frame
      state = result.state
      frame = renderMultiselect(question, state)

      if (result.kind === 'submit') {
        clearLines(previous.split('\n').length - 1)
        const names = state.choices
          .filter(c => state.selected.has(c.id))
          .map(c => c.label)
        write(
          `${GREEN}?${RESET} ${question} ` +
            `${CYAN}${names.length ? names.join(', ') : 'none'}${RESET}\n`,
        )
        return state.choices
          .filter(c => state.selected.has(c.id))
          .map(c => c.id)
      }

      clearLines(previous.split('\n').length - 1)
      write(frame)
    }
  } finally {
    write(`${ESC}[?25h`) // always give the cursor back
  }
  return null
}
