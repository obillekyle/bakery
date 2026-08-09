import { createElement, Fragment, html } from './jsx'

const hasDevWorkerArg = process.argv.includes('--dev-worker')
const isThreadWorker =
  process.argv.includes('--thread-worker') || process.env.THREAD_WORKER === '1'
const isDev = process.argv.includes('--dev') || hasDevWorkerArg
const isTest = process.env.NODE_ENV === 'test' || Bun.env.NODE_ENV === 'test'
const mode = hasDevWorkerArg
  ? 'dev-worker'
  : isThreadWorker
    ? 'thread-worker'
    : isDev
      ? 'development'
      : 'production'

const getArgValue = (name: string) => {
  const prefix = `${name}=`
  const found = process.argv.find(a => a.startsWith(prefix))
  if (found) return found.slice(prefix.length)
  const idx = process.argv.indexOf(name)
  return idx !== -1 && idx + 1 < process.argv.length
    ? process.argv[idx + 1]
    : null
}

const threadId = process.env.THREAD_ID ?? getArgValue('--thread-id') ?? '0'

/**
 * An accessor pair, not a bare getter.
 *
 * These are `process.env` properties, and a getter with no setter is readonly:
 * in strict-mode ESM an assignment to one throws
 * `TypeError: Attempted to assign to readonly property`. `threads.ts` assigns
 * `THREAD_ID = '0'` on the single-worker/clamped path (deliberately not
 * `THREAD_WORKER` — a cluster of one must keep full-size caches). When the
 * assignment was getter-only it was wrapped in `Try(...)`, so the throw was
 * swallowed and the flags never moved — `reusePort`, the per-worker cache
 * scaling and the startup banner all silently read the master's values. The
 * `Try(...)` was what made a dead code path look deliberate.
 */
const accessor = (initial: any) => {
  let value = initial
  return {
    get: () => value,
    set: (next: any) => {
      value = next
    },
    enumerable: true,
    configurable: true,
  }
}

Object.defineProperties(process.env, {
  DEV: accessor(isDev),
  TEST: accessor(isTest),
  PROD: accessor(!isDev && !hasDevWorkerArg),
  WORKER: accessor(hasDevWorkerArg || isThreadWorker),
  DEV_WORKER: accessor(hasDevWorkerArg),
  THREAD_WORKER: accessor(isThreadWorker),
  THREAD_ID: accessor(threadId),
  MODE: accessor(mode),
})

/**
 * "This process is the worker of a *development* server."
 *
 * `DEV_WORKER` alone would answer the same — `isDev` above is
 * `--dev || --dev-worker`, so a dev worker always carries `DEV` too — but the
 * conjunction is the condition the call sites were written against, and it
 * says what it means. Exported from here rather than recomputed per module
 * because three of them branch on it (`cli/worker.ts`,
 * `compiler/dev-service.ts`, the dashboard plugin's `setup.ts`) and a
 * byte-identical expression in three files is three chances to drift.
 *
 * Read once, at the moment the accessors above are installed: the flags do not
 * move afterwards, so this is the same value each copy computed at its own
 * load time.
 */
export const isDevWorker = Boolean(
  import.meta.env.DEV_WORKER && import.meta.env.DEV,
)

Object.assign(globalThis, {
  createElement,
  Fragment,
  html,
})

process.on('SIGHUP', () => {})
process.on('SIGBREAK', () => {})
