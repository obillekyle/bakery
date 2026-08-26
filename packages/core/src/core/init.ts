import { randomId } from '../utils/isomorphic/misc'
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
 * The mode flags are **strings on `process.env`** — `'1'` for true, `''` for
 * false. They were booleans behind an accessor pair until Bun 1.4.
 *
 * **Bun 1.4.0 rejects accessor descriptors on `process.env` outright.**
 * `Object.defineProperty(process.env, 'X', { get })` throws
 * `ERR_INVALID_OBJECT_DEFINE_PROPERTY`. This block runs at import time in every
 * entry, so the whole framework died on `import` under current Bun — a
 * scaffolded app could not reach step 2 of its own quick start. Data
 * descriptors are accepted and coerce anyway (`{ value: false }` reads back as
 * `"false"`), so a boolean here is no longer expressible at all; and
 * `import.meta.env === process.env` in Bun, so there is no second object to put
 * one on.
 *
 * **`'1'` / `''`, never `'true'` / `'false'`.** Truthiness has to survive the
 * coercion: `"false"` is a truthy string, so every `if (import.meta.env.DEV)`
 * in the codebase would have inverted silently rather than failed. `''` also
 * keeps the key *present* — `'PROD' in process.env` stays true — which is what
 * separates "explicitly not production" from "never booted", a distinction
 * `utils/http/authorize.ts` depends on to fail closed.
 *
 * Plain assignment, so `threads.ts` can still assign `THREAD_ID = '0'` on the
 * single-worker/clamped path (deliberately not `THREAD_WORKER` — a cluster of
 * one must keep full-size caches). That assignment is why these were an
 * accessor *pair* rather than a bare getter: a getter with no setter is
 * readonly, the assignment threw, and the throw was swallowed by a `Try(...)`
 * that made a dead code path look deliberate.
 */
const flag = (on: boolean) => (on ? '1' : '')

process.env.DEV = flag(isDev)
process.env.TEST = flag(isTest)
process.env.PROD = flag(!isDev && !hasDevWorkerArg)
process.env.WORKER = flag(hasDevWorkerArg || isThreadWorker)
process.env.DEV_WORKER = flag(hasDevWorkerArg)
process.env.THREAD_WORKER = flag(isThreadWorker)
process.env.THREAD_ID = threadId
process.env.MODE = mode

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
  // The same value the browser runtime binds (`client/utils.ts`), so code
  // that moves between an SFC's browser script and its server block — where
  // it runs as a bare global either way — does not lose the name. Declared
  // once, in `shared.d.ts`.
  randomId,
})

process.on('SIGHUP', () => {})
process.on('SIGBREAK', () => {})
