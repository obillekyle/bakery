import { createElement, Fragment, html } from './jsx'

const isDevWorker = process.argv.includes('--dev-worker')
const isThreadWorker =
  process.argv.includes('--thread-worker') ||
  process.env.THREAD_WORKER === '1'
const isDev = process.argv.includes('--dev') || isDevWorker
const isTest = process.env.NODE_ENV === 'test' || Bun.env.NODE_ENV === 'test'
const mode = isDevWorker
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

const threadId =
  process.env.THREAD_ID ?? getArgValue('--thread-id') ?? '0'

const getter = (v: any) => ({
  get: () => v,
  enumerable: true,
  configurable: true,
})

Object.defineProperties(process.env, {
  DEV: getter(isDev),
  TEST: getter(isTest),
  PROD: getter(!isDev && !isDevWorker),
  WORKER: getter(isDevWorker || isThreadWorker),
  DEV_WORKER: getter(isDevWorker),
  THREAD_WORKER: getter(isThreadWorker),
  THREAD_ID: getter(threadId),
  MODE: getter(mode),
})

Object.assign(globalThis, {
  createElement,
  Fragment,
  html,
})

process.on('SIGHUP', () => {})
process.on('SIGBREAK', () => {})
