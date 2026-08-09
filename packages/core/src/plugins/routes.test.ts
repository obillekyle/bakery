import { describe, expect, test } from 'bun:test'
import { routeTable } from './routes'

const req = (path: string, method = 'GET') =>
  new Request(`http://localhost${path}`, { method })

describe('routeTable', () => {
  test('matches a bare path on any method', async () => {
    const dispatch = routeTable({
      '/api/_x/stats': () => new Response('stats'),
    })
    expect(await (await dispatch(req('/api/_x/stats')))?.text()).toBe('stats')
    expect(await (await dispatch(req('/api/_x/stats', 'DELETE')))?.text()).toBe(
      'stats',
    )
  })

  test('a method-qualified key only matches that method', async () => {
    const dispatch = routeTable({
      'POST /api/_x/reset': () => new Response('reset'),
    })
    expect(await (await dispatch(req('/api/_x/reset', 'POST')))?.text()).toBe(
      'reset',
    )
    // Falls through to no match rather than running the handler.
    expect(await dispatch(req('/api/_x/reset', 'GET'))).toBeNull()
  })

  test('a method-qualified key wins over a bare one for the same path', async () => {
    const dispatch = routeTable({
      '/api/_x/thing': () => new Response('any'),
      'POST /api/_x/thing': () => new Response('post'),
    })
    expect(await (await dispatch(req('/api/_x/thing', 'POST')))?.text()).toBe(
      'post',
    )
    expect(await (await dispatch(req('/api/_x/thing', 'GET')))?.text()).toBe(
      'any',
    )
  })

  test('an unmatched path resolves to null, not undefined', async () => {
    const dispatch = routeTable({ '/api/_x/a': () => new Response('a') })
    expect(await dispatch(req('/api/_x/nope'))).toBeNull()
  })

  test('does not resolve inherited Object.prototype members', async () => {
    const dispatch = routeTable({})
    // A plain `routes[path]` lookup would return Object.prototype.constructor
    // here and try to call it as a handler.
    expect(await dispatch(req('/constructor'))).toBeNull()
    expect(await dispatch(req('/toString'))).toBeNull()
  })

  test('a handler returning undefined is normalised to null', async () => {
    const dispatch = routeTable({ '/api/_x/void': () => undefined })
    expect(await dispatch(req('/api/_x/void'))).toBeNull()
  })

  test('passes the parsed URL through to the handler', async () => {
    const dispatch = routeTable({
      '/api/_x/q': (_req, url) => new Response(url.searchParams.get('n') ?? ''),
    })
    expect(await (await dispatch(req('/api/_x/q?n=7')))?.text()).toBe('7')
  })
})

/**
 * The systemic half of the dashboard's defect.
 *
 * A bare key matches every method, so a mutating endpoint registered under one
 * answered a cross-site `GET` -- and `checkCsrf` is no help there, because it
 * waves GET through by definition. The strictness is therefore proportional to
 * what the table declared: a bare key is same-origin-only on every method, a
 * method-qualified key gets the ordinary CSRF check.
 */
describe('routeTable - a plugin cannot forget CSRF', () => {
  const site = 'http://localhost:3000'
  const evil = 'https://evil.example'

  const from = (
    path: string,
    method: string,
    headers: Record<string, string>,
  ) =>
    new Request(`${site}${path}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
    })

  test('a bare key refuses a cross-site GET', async () => {
    let ran = false
    const dispatch = routeTable({
      '/api/_x/execute-action': () => {
        ran = true
        return new Response('mutated')
      },
    })

    // The exact shape of the dashboard exploit: <img src=...> on evil.example.
    const res = await dispatch(
      from('/api/_x/execute-action', 'GET', { 'sec-fetch-site': 'cross-site' }),
    )
    expect((res as Response).status).toBe(403)
    expect(ran).toBe(false)
  })

  test('a bare key refuses a cross-origin GET signalled by Origin', async () => {
    const dispatch = routeTable({ '/api/_x/wipe': () => new Response('gone') })
    const res = await dispatch(from('/api/_x/wipe', 'GET', { origin: evil }))
    expect((res as Response).status).toBe(403)
  })

  test('a bare key still answers same-origin traffic', async () => {
    const dispatch = routeTable({
      '/api/_x/stats': () => new Response('stats'),
    })
    const res = await dispatch(
      from('/api/_x/stats', 'GET', {
        origin: site,
        'sec-fetch-site': 'same-origin',
      }),
    )
    expect(await (res as Response).text()).toBe('stats')
  })

  test('a bare key still answers a client that sends no origin headers', async () => {
    // curl, a health check, the test suite. Unchanged from before the guard.
    const dispatch = routeTable({ '/api/_x/ping': () => new Response('pong') })
    expect(await (await dispatch(req('/api/_x/ping')))?.text()).toBe('pong')
    expect(await (await dispatch(req('/api/_x/ping', 'DELETE')))?.text()).toBe(
      'pong',
    )
  })

  test('a method-qualified key gets the ordinary CSRF check', async () => {
    const dispatch = routeTable({
      'POST /api/_x/reset': () => new Response('reset'),
    })
    const res = await dispatch(from('/api/_x/reset', 'POST', { origin: evil }))
    expect((res as Response).status).toBe(403)
  })

  test('a method-qualified GET is the opt-out for cross-origin reads', async () => {
    // Naming the method is the author saying they thought about it, so the
    // strict bare-key rule does not apply.
    const dispatch = routeTable({
      'GET /api/_x/public': () => new Response('public'),
    })
    const res = await dispatch(from('/api/_x/public', 'GET', { origin: evil }))
    expect(await (res as Response).text()).toBe('public')
  })

  test('an unmatched path still resolves to null, not a 403', async () => {
    // Otherwise the guard would claim paths the table never declared and stop
    // them falling through to the rest of the router.
    const dispatch = routeTable({ '/api/_x/a': () => new Response('a') })
    const res = await dispatch(from('/api/_x/nope', 'GET', { origin: evil }))
    expect(res).toBeNull()
  })
})

/**
 * The two bundled plugins' tables, reproduced exactly, so a change to the
 * guard that would break them fails here rather than in their package.
 */
describe('routeTable - the bundled plugin tables still work', () => {
  const analytics = routeTable({
    '/_analytics/ping': () => new Response('pong'),
    'POST /api/_analytics/reset': () => new Response('reset'),
    '/api/_analytics/stats': () => new Response('stats'),
  })

  test('analytics answers its own page and its own tests', async () => {
    const sameOrigin = { 'sec-fetch-site': 'same-origin' }
    const ping = new Request('http://localhost:3000/_analytics/ping', {
      headers: sameOrigin,
    })
    expect(await (await analytics(ping))?.text()).toBe('pong')

    const stats = new Request('http://localhost:3000/api/_analytics/stats', {
      headers: sameOrigin,
    })
    expect(await (await analytics(stats))?.text()).toBe('stats')

    const reset = new Request('http://localhost:3000/api/_analytics/reset', {
      method: 'POST',
      headers: sameOrigin,
      body: '{}',
    })
    expect(await (await analytics(reset))?.text()).toBe('reset')
  })

  test('analytics is unchanged for header-less requests', async () => {
    expect(await (await analytics(req('/_analytics/ping')))?.text()).toBe(
      'pong',
    )
    expect(await (await analytics(req('/api/_analytics/stats')))?.text()).toBe(
      'stats',
    )
    expect(
      await (await analytics(req('/api/_analytics/reset', 'POST')))?.text(),
    ).toBe('reset')
  })
})
