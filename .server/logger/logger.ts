import { PromptTracker } from '@server/compiler/prompt-tracker'
import { Case } from '@server/utils/common/case'
import { match } from '@server/utils/common/match'

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

function colorizeTerminal(msg: string): string {
  const colors: MapOf<string> = {
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

  return msg.replace(
    /%<([a-zA-Z0-9]+)>|%([a-zA-Z0-9*%])/g,
    (match, longName, short) => {
      if (longName) return colors[longName] || match
      if (short === '%') return '%'
      return colors[short] || match
    },
  )
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

  Promise.try(() => onLogCallback?.({ level, by, msg })).catch(() => {})
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
    Promise.try(() =>
      onLogCallback?.({ level: 'warn', by, msg: promptMsg }),
    ).catch(() => {})

    const response = prompt(promptStr)?.trim().toLowerCase()
    return response === 'y' || response === 'yes'
  })
}

export function select(msg: string, options: string[], by = 'global'): string {
  const index = selectIndex(msg, options, by)
  return options[index] as string
}

function readValidIndex(_msg: string, max: number, by: string): number {
  const promptMsg = `Select an option (1-${max}): `
  const formatted = getFormattedLine(promptMsg, 0, 1, 'info', by, false)
  const promptStr = formatted ? colorizeTerminal(formatted) : ''

  while (true) {
    Promise.try(() =>
      onLogCallback?.({ level: 'info', by, msg: promptMsg }),
    ).catch(() => {})

    const response = prompt(promptStr)?.trim()
    const num = parseInt(response || '', 10)
    if (!Number.isNaN(num) && num >= 1 && num <= max) {
      return num - 1
    }
    log({ level: 'error', by, msg: 'Invalid option.' })
  }
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

export function messageLogger<T extends MapOf<string>>(
  loggerInstance: Logger,
  targetMsgs: T,
) {
  return new Proxy(targetMsgs, {
    get(target, prop: string) {
      return (payload?: MapOf<any>) => {
        const raw = target[prop] || `E Error message not found: ${String(prop)}`

        const spaceIdx = raw.indexOf(' ')
        const rawLevel = spaceIdx > -1 ? raw.substring(0, spaceIdx) : 'E'
        const template = spaceIdx > -1 ? raw.substring(spaceIdx + 1) : raw

        const formattedMessage = template.replace(/\{([^}]+)\}/g, (_, key) => {
          return String(payload?.[key] ?? `{${key}}`)
        })

        const mappedLevel: LogLevels = match(rawLevel, {
          W: 'warn',
          E: 'error',
          D: 'debug',
          [match]: 'info',
        })

        loggerInstance.log(formattedMessage, mappedLevel)
      }
    },
  }) as any as Messages<T>
}
