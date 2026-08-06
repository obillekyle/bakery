import { beforeAll, describe, expect, test } from 'bun:test'
import { hostStore } from '../../core/bakery'
import { getConfig, initConfig } from '../../core/config'
import { MiddlewareHandler } from './$middleware'

beforeAll(async () => {
  await initConfig()
})

/** Scope config overrides to this test without mutating the frozen global config. */
function withConfig<T>(overrides: any, fn: () => Promise<T>): Promise<T> {
  return hostStore.run(
    { config: { ...getConfig(), ...overrides }, hostname: 'localhost' } as any,
    fn,
  )
}

/** Scope a middleware chain to this test without mutating the frozen global config. */
function withMiddleware<T>(middleware: any[], fn: () => Promise<T>): Promise<T> {
  return withConfig({ middleware }, fn)
}

describe('MiddlewareHandler request isolation', () => {
  test("concurrent requests never receive each other's response", async () => {
    // The result used to be parked on a static field between canHandle() and
    // handle(), so any await boundary let two in-flight requests swap responses
    // (and each other's Set-Cookie headers).
    const middleware = [
      async (req: Request) => {
        const id = new URL(req.url).searchParams.get('id')!
        // Stagger completion so the requests interleave.
        await Bun.sleep(Number(id) % 2 === 0 ? 12 : 2)
        return new Response(id, { headers: { 'set-cookie': `who=${id}` } })
      },
    ]

    const ids = Array.from({ length: 12 }, (_, i) => String(i))
    const reqs = ids.map(id => new Request(`http://localhost/p?id=${id}`))

    const results = await withMiddleware(middleware, async () => {
      // The registry resolves canHandle across handlers before calling handle,
      // so these two phases really are separated by other awaited work.
      const matches = await Promise.all(
        reqs.map(req => MiddlewareHandler.canHandle('/p', req)),
      )
      for (const matched of matches) expect(matched).toBe(true)

      return Promise.all(
        reqs.map(async (req, i) => {
          const res = (await MiddlewareHandler.handle('/p', req)) as Response
          return {
            id: ids[i],
            body: await res.text(),
            cookie: res.headers.get('set-cookie'),
          }
        }),
      )
    })

    for (const { id, body, cookie } of results) {
      expect(body).toBe(id)
      expect(cookie).toBe(`who=${id}`)
    }
  })

  test('a throwing middleware fails closed instead of letting the request through', async () => {
    const middleware = [
      () => {
        throw new Error('auth check exploded')
      },
    ]

    const res = await withMiddleware(
      middleware,
      () =>
        MiddlewareHandler.handle(
          '/protected',
          new Request('http://localhost/protected'),
        ) as Promise<Response>,
    )

    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(500)
  })

  test('returns false when no middleware produces a response', async () => {
    const matched = await withMiddleware([async () => undefined], () =>
      MiddlewareHandler.canHandle('/open', new Request('http://localhost/open')),
    )
    expect(matched).toBe(false)
  })
})

describe('config.onRequest', () => {
  const forbid = () => new Response('Forbidden', { status: 403 })

  test('a non-HTML response is returned, not dropped', async () => {
    // `return (await injectIfHtml(intercepted)) || undefined` used to sit here.
    // injectIfHtml returns null for anything that is not HTML, so a plain-text
    // 403 became `undefined` and the request carried on to the page handler —
    // fail-open in the hook whose shape invites auth checks.
    const res = await withConfig(
      { onRequest: forbid },
      () =>
        MiddlewareHandler.handle(
          '/protected',
          new Request('http://localhost/protected'),
        ) as Promise<Response>,
    )

    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Forbidden')
  })

  test('a non-HTML denial makes canHandle report a match', async () => {
    // The consequence of the above: canHandle is `Boolean(result)`, so a
    // dropped response also meant the registry never selected this handler.
    const matched = await withConfig({ onRequest: forbid }, () =>
      MiddlewareHandler.canHandle(
        '/protected',
        new Request('http://localhost/protected'),
      ),
    )

    expect(matched).toBe(true)
  })

  test('an HTML response is still injected', async () => {
    const res = await withConfig(
      {
        onRequest: () =>
          new Response('<html><head></head><body>nope</body></html>', {
            status: 403,
            headers: { 'content-type': 'text/html' },
          }),
      },
      () =>
        MiddlewareHandler.handle(
          '/protected',
          new Request('http://localhost/protected'),
        ) as Promise<Response>,
    )

    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('type="importmap"')
  })

  test('no response from onRequest still falls through to the chain', async () => {
    const matched = await withConfig({ onRequest: () => undefined }, () =>
      MiddlewareHandler.canHandle('/open', new Request('http://localhost/open')),
    )

    expect(matched).toBe(false)
  })
})
