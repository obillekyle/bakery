import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
  NOOP,
} from '../core/config'
import { handleRequestError } from '../router'
import {
  DEV_ERROR_PLUGIN,
  registerDevErrorOverlay,
  setDevErrorSink,
} from './dev-service'

/**
 * The wiring, end to end, without a socket.
 *
 * `dev-service.test.ts` pins the pieces — classification, frame shape, the
 * sink's no-op-when-unset, registration order. This file pins the one claim
 * those cannot make on their own: that a request-time failure travelling the
 * *real* error path (`router.ts handleRequestError`) reaches the sink at all.
 *
 * That was the defect. `notifyError`, the only producer of the overlay frame,
 * had exactly one non-test caller — the watcher's `catch` around
 * `processFileEvent`, reachable only on an internal/IO fault — while every
 * failure a developer actually hits went through `handleRequestError` and
 * published nothing. Before the overlay plugin existed, every assertion below
 * saw an empty `frames`.
 */
beforeAll(async () => {
  await initConfig()
})

afterEach(() => {
  __resetTestConfig()
  setDevErrorSink(null)
})

/**
 * A config isolated from the process-wide one: `registerDevErrorOverlay`
 * mutates the plugin array in place (the resolved config is frozen, so the
 * array is the only writable seam), and a test must not leave the overlay
 * plugin registered for every later test file in the run.
 *
 * `onError: NOOP` replaces the default handler, which logs `errorBody` at warn
 * level — that is the config's job in a real app and noise here.
 */
function withOverlay(plugins: any[] = []) {
  const frames: { title: string; body: string }[] = []
  __setTestConfig({ plugins, onError: NOOP })
  setDevErrorSink((title, body) => void frames.push({ title, body }))
  registerDevErrorOverlay()
  return frames
}

describe('request-time errors reach the overlay', () => {
  test('a thrown handler error is published with its stack', async () => {
    const frames = withOverlay()

    await handleRequestError(
      '/broken',
      new Request('http://localhost:3284/broken'),
      new Error('Unexpected token, expected ")"'),
    )

    expect(frames).toHaveLength(1)
    expect(frames[0].title).toBe('500 Unexpected token, expected ")" — /broken')
    // `extractErrorData` puts the stack in `errorBody`; losing it here would
    // leave the overlay showing a headline with nothing under it.
    expect(frames[0].body).toContain('Unexpected token')
  })

  test('a 5xx Response answer is published too', async () => {
    const frames = withOverlay()

    await handleRequestError(
      '/api/thing',
      new Request('http://localhost:3284/api/thing'),
      new Response('nope', { status: 503, statusText: 'Service Unavailable' }),
    )

    expect(frames).toHaveLength(1)
    expect(frames[0].title).toBe('503 Service Unavailable — /api/thing')
  })

  test('a 404 does not cover the page', async () => {
    const frames = withOverlay()

    await handleRequestError(
      '/missing',
      new Request('http://localhost:3284/missing'),
      new Response('', { status: 404, statusText: 'Not Found' }),
    )

    expect(frames).toEqual([])
  })

  /**
   * `PluginHooks.onError` returns the first response any plugin gives and stops
   * iterating, so an app plugin that renders its own error page would have
   * hidden every failure from an overlay plugin registered behind it.
   * Registration goes to the front for exactly this case.
   */
  test('an app plugin that answers cannot suppress it', async () => {
    const answered: string[] = []
    const frames = withOverlay([
      {
        name: 'app-error-page',
        onError() {
          answered.push('yes')
          return new Response('app error page', { status: 500 })
        },
      },
    ])

    await handleRequestError(
      '/broken',
      new Request('http://localhost:3284/broken'),
      new Error('boom'),
    )

    expect(answered).toEqual(['yes'])
    expect(frames).toHaveLength(1)
    expect(frames[0].title).toBe('500 boom — /broken')
  })

  /**
   * The overlay observes; it must never become the answer. `PluginHooks.onError`
   * would return this plugin's value as the response if it were anything but
   * nullish, replacing the app's error page with nothing.
   */
  test('registering it does not change the response', async () => {
    __setTestConfig({ plugins: [], onError: NOOP })
    const req = new Request('http://localhost:3284/broken')
    const before = await handleRequestError('/broken', req, new Error('boom'))

    const frames = withOverlay()
    const after = await handleRequestError('/broken', req, new Error('boom'))

    expect(frames).toHaveLength(1)
    expect(after instanceof Response).toBe(before instanceof Response)
    expect((after as Response).status).toBe((before as Response).status)
    expect(await (after as Response).text()).toBe(
      await (before as Response).text(),
    )
  })

  test('with no sink installed the whole path is inert', async () => {
    const plugins: any[] = []
    __setTestConfig({ plugins, onError: NOOP })
    registerDevErrorOverlay()
    expect(plugins[0].name).toBe(DEV_ERROR_PLUGIN)

    // Sink deliberately not installed — this is PROD, a cluster worker, and
    // every consumer that never starts a compile service.
    const res = await handleRequestError(
      '/broken',
      new Request('http://localhost:3284/broken'),
      new Error('boom'),
    )

    expect(res instanceof Response).toBe(true)
  })
})
