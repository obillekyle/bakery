import { PromptTracker } from '../compiler/prompt-tracker'
import { Case } from '../utils/common/case'
import { match } from '../utils/common/match'
import { Try } from '../utils/common/try'
import type { MapOf } from '../types'

const logLevels = ['info', 'warn', 'error', 'fatal', 'debug', 'trace'] as const
const byLength = 15

export type LogLevels = (typeof logLevels)[number]

export type LoggerEntry = {
  level?: LogLevels
  by?: string
  msg: string
}

function getStackTrace(depth = 10, startAt = 0): string[] {
  const stack = new Error().stack
  const cwd = process.cwd()
  if (!stack) return []
  startAt += 2
  return stack
    .split('\n')
    .map(line => line.replace(cwd, '.'))
    .slice(startAt, startAt + depth)
}

const levelColors: Record<LogLevels | 'reset', string> = {
  info: '%w', // White (Regular)
  warn: '%y', // Yellow
  error: '%r', // Red
  fatal: '%r;31m', // Bold Red
  debug: '%m', // Magenta
  trace: '%d', // Gray
  reset: '%0', // Reset
}

let onLogCallback: ((entry: LoggerEntry) => void) | null = null
export function setLogCallback(cb: (entry: LoggerEntry) => void) {
  onLogCallback = cb
}

/**
 * Hand an entry to the registered sink, if there is one.
 *
 * Three call sites used to spell this as `Promise.try(() =>
 * onLogCallback?.(…)).catch(() => {})`, which allocated two promises and
 * scheduled a microtask for *every* line — including every line logged while
 * no sink was registered at all. `Try` swallows a synchronous throw and a
 * rejected promise alike (see `utils/isomorphic/try.ts`) without allocating
 * anything on the synchronous path, which is the only path a sink typed
 * `=> void` is supposed to take.
 *
 * The call stays synchronous, as `Promise.try` also was: `logger.test.ts`
 * asserts the callback has fired by the time `log()` returns.
 */
function emit(entry: LoggerEntry): void {
  if (!onLogCallback) return
  Try(() => onLogCallback?.(entry))
}

// Hoisted: both were rebuilt on every call, and neither depends on the input.
// The colour table is a 23-property literal and the pattern a regex literal,
// so a process logging steadily paid for both on every line.
const COLORS: MapOf<string> = {
  r: '\x1b[31m', // Red
  g: '\x1b[32m', // Green
  y: '\x1b[33m', // Yellow
  b: '\x1b[34m', // Blue
  m: '\x1b[35m', // Magenta
  c: '\x1b[36m', // Cyan
  w: '\x1b[37m', // White
  d: '\x1b[90m', // Gray / Dark Gray
  B: '\x1b[38;5;94m', // Brown
  p: '\x1b[38;5;129m', // Purple / Indigo
  o: '\x1b[38;5;208m', // Orange
  '*': '\x1b[0m', // Reset
  '0': '\x1b[0m', // Reset

  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brown: '\x1b[38;5;94m',
  purple: '\x1b[38;5;129m',
  orange: '\x1b[38;5;208m',
  reset: '\x1b[0m',
}

// Safe to share despite the /g flag: `String.prototype.replace` resets
// `lastIndex` on a global regex before it starts.
const RX_COLORIZE = /%<([a-zA-Z0-9]+)>|%([a-zA-Z0-9*%])/g

function colorizeTerminal(msg: string): string {
  return msg.replace(RX_COLORIZE, (match, longName, short) => {
    if (longName) return COLORS[longName] || match
    if (short === '%') return '%'
    return COLORS[short] || match
  })
}

function getFormattedLine(
  line: string,
  index: number,
  totalLines: number,
  level: LogLevels,
  by: string,
  newLine: boolean,
): string | null {
  if (index === totalLines - 1 && line === '' && index > 0) return null

  const color = levelColors[level] || levelColors.info
  const lvTag = `${color}[${Case.upper(level.at(0) || '?')}]`
  const byPad =
    by.length <= byLength
      ? by.padEnd(byLength)
      : `${by.substring(0, byLength - 3)}...`

  let message = `${lvTag} ${byPad}%0 ${line}%0 `

  if ((level === 'trace' || level === 'fatal') && index === totalLines - 1) {
    const stack = getStackTrace(5, 1)
    const prefix = `\n${lvTag} ${byPad}%d `
    message += `${prefix + stack.join(prefix)}%0`
  }

  message += `%0${newLine || index < totalLines - 1 ? '\n' : ''}`
  return message
}

export function log(
  { level = 'info', by = 'global', msg }: LoggerEntry,
  newLine = true,
) {
  if (level === 'debug' && import.meta.env.PROD) return

  const lines = msg.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const formatted = getFormattedLine(
      lines[i],
      i,
      lines.length,
      level,
      by,
      newLine,
    )
    if (formatted !== null) {
      process.stdout.write(colorizeTerminal(formatted))
    }
  }

  emit({ level, by, msg })
}

function withPromptTracker<T>(fn: () => T): T {
  const isWatcherActive = process.env.DEV_WATCHER_ACTIVE === '1'
  if (isWatcherActive) {
    PromptTracker.activate(process.pid)
  }

  try {
    return fn()
  } finally {
    if (isWatcherActive) {
      PromptTracker.deactivate(process.pid)
    }
  }
}

export function confirm(msg: string, by = 'global'): boolean {
  return withPromptTracker(() => {
    const promptMsg = `%y${msg} (y/n): %r`

    const formatted = getFormattedLine(promptMsg, 0, 1, 'warn', by, false)
    const promptStr = formatted ? colorizeTerminal(formatted) : ''
    emit({ level: 'warn', by, msg: promptMsg })

    // No TTY: decline rather than treat an unanswerable prompt as consent.
    if (!isInteractive()) return false

    const response = prompt(promptStr)?.trim().toLowerCase()
    return response === 'y' || response === 'yes'
  })
}

const MAX_PROMPT_ATTEMPTS = 10

/** False in Docker/CI, where `prompt()` returns null instead of blocking. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function select(msg: string, options: string[], by = 'global'): string {
  const index = selectIndex(msg, options, by)
  return options[index] as string
}

function readValidIndex(_msg: string, max: number, by: string): number {
  const promptMsg = `Select an option (1-${max}): `
  const formatted = getFormattedLine(promptMsg, 0, 1, 'info', by, false)
  const promptStr = formatted ? colorizeTerminal(formatted) : ''

  // Without a TTY (Docker, CI) `prompt()` returns null immediately, so looping
  // here would spin forever printing "Invalid option."
  if (!isInteractive()) {
    log({
      level: 'error',
      by,
      msg: 'Cannot prompt for input: no interactive terminal. Re-run with an explicit choice (e.g. --choose=db) or a TTY.',
    })
    process.exit(1)
  }

  let attempts = 0
  while (attempts++ < MAX_PROMPT_ATTEMPTS) {
    emit({ level: 'info', by, msg: promptMsg })

    const response = prompt(promptStr)?.trim()
    const num = parseInt(response || '', 10)
    if (!Number.isNaN(num) && num >= 1 && num <= max) {
      return num - 1
    }
    log({ level: 'error', by, msg: 'Invalid option.' })
  }

  log({
    level: 'error',
    by,
    msg: `No valid option after ${MAX_PROMPT_ATTEMPTS} attempts. Aborting.`,
  })
  process.exit(1)
}

export function selectIndex(msg: string, opt: string[], by = 'global'): number {
  return withPromptTracker(() => {
    log({ by, msg: '\n' })
    log({ by, msg })

    opt.forEach((opt, i) => void log({ by, msg: `  ${i + 1}. ${opt}` }))

    const index = readValidIndex(msg, opt.length, by)
    log({ by, msg: '\n' })
    return index
  })
}

export class Logger {
  constructor(private by: string) {}

  static log = log
  static confirm = confirm
  static select = select
  static selectIndex = selectIndex

  static messages<T extends MapOf<string>>(by: string, msgs: T) {
    const logger = new Logger(by)
    return messageLogger(logger, msgs)
  }

  log(msg: string, level?: LogLevels) {
    log({ level, by: this.by, msg })
  }

  confirm(msg: string) {
    return confirm(msg, this.by)
  }

  select(msg: string, options: string[]) {
    return select(msg, options, this.by)
  }

  selectIndex(msg: string, options: string[]) {
    return selectIndex(msg, options, this.by)
  }
}

type Prettify<T> = { [K in keyof T]: T[K] } & {}

type ExtractArgs<S extends string> =
  S extends `${infer _}{${infer Param}}${infer Rest}`
    ? Prettify<{ [K in Param]: string | number | boolean } & ExtractArgs<Rest>>
    : // biome-ignore lint/complexity/noBannedTypes: a
      {}

type Messages<T extends MapOf<string>> = {
  [K in keyof T]: T[K] extends string
    ? keyof ExtractArgs<T[K]> extends never
      ? () => void
      : (payload: ExtractArgs<T[K]>) => void
    : never
}

// Shared for the same reason as RX_COLORIZE above.
const RX_PARAM = /\{([^}]+)\}/g

type ParsedMessage = {
  /** The string this was parsed from — the cache's validity check. */
  raw: string
  level: LogLevels
  template: string
}

/**
 * Split `'W Rate limited: %y{ip}%*'` into its level tag and its template.
 *
 * A pure function of the declared message string, so it is a per-key constant
 * and belongs behind the cache in `messageLogger` rather than on the call path.
 */
function parseMessage(raw: string): ParsedMessage {
  const spaceIdx = raw.indexOf(' ')
  const rawLevel = spaceIdx > -1 ? raw.substring(0, spaceIdx) : 'E'

  return {
    raw,
    level: match(rawLevel, {
      W: 'warn',
      E: 'error',
      D: 'debug',
      [match]: 'info',
    }),
    template: spaceIdx > -1 ? raw.substring(spaceIdx + 1) : raw,
  }
}

export function messageLogger<T extends MapOf<string>>(
  loggerInstance: Logger,
  targetMsgs: T,
) {
  /**
   * One entry per *declared* key, so it is bounded by the message table — the
   * tables in `serve-log.ts` are literals of a dozen-odd entries each.
   * Undeclared props are deliberately left uncached: the trap fabricates a
   * message for those, and a caller reading arbitrary property names off the
   * proxy would otherwise grow this map without limit (convention 6).
   */
  const emitters = new Map<string, ParsedMessage & { fn: Emitter }>()

  const build =
    (parsed: ParsedMessage): Emitter =>
    (payload?: MapOf<any>) => {
      const formattedMessage = parsed.template.replace(RX_PARAM, (_, key) => {
        return String(payload?.[key] ?? `{${key}}`)
      })

      loggerInstance.log(formattedMessage, parsed.level)
    }

  return new Proxy(targetMsgs, {
    get(target, prop: string) {
      const raw = target[prop]
      if (!raw) return build(parseMessage(msgNotFound(prop)))

      let cached = emitters.get(prop)
      // Re-parse when the table was mutated under us. `raw` is the entire
      // parse input, so comparing it is the whole validity check.
      if (!cached || cached.raw !== raw) {
        const parsed = parseMessage(raw)
        cached = { ...parsed, fn: build(parsed) }
        emitters.set(prop, cached)
      }

      return cached.fn
    },
  }) as any as Messages<T>
}

type Emitter = (payload?: MapOf<any>) => void

const msgNotFound = (prop: string) =>
  `E Error message not found: ${String(prop)}`
