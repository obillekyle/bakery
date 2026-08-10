import { beforeAll, describe, expect, test } from 'bun:test'
import { hostStore } from '../../core/bakery'
import { getConfig, initConfig } from '../../core/config'
import { processResponse } from '../../router'
import { JsonResponseData } from '../../utils'
import { response } from '../../utils/http'
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
function withMiddleware<T>(
  middleware: any[],
  fn: () => Promise<T>,
): Promise<T> {
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
      MiddlewareHandler.canHandle(
        '/open',
        new Request('http://localhost/open'),
      ),
    )
    expect(matched).toBe(false)
  })
})

describe('a response.json envelope from middleware stops the chain', () => {
  // `if (result instanceof Response)` used to be the only accepted shape, so a
  // guard returning the framework's own one-envelope idiom was silently
  // ignored and the request carried on. On a path with no route that surfaced
  // as a confusing 404; on a path that *does* exist — which is every path a
  // guard is written for — the protected page was served with a 200.
  const deny = () => response.json.error(401, 'Sign in required')

  test('the envelope is returned, not dropped', async () => {
    const res = await withMiddleware([deny], () =>
      Promise.resolve(
        MiddlewareHandler.handle(
          '/admin',
          new Request('http://localhost/admin'),
        ),
      ),
    )

    expect(res).toBeInstanceOf(JsonResponseData)
    expect((res as JsonResponseData).status).toBe(401)
    expect((res as JsonResponseData).message).toBe('Sign in required')
  })

  test('canHandle reports a match, so the page handler never runs', async () => {
    const matched = await withMiddleware([deny], () =>
      MiddlewareHandler.canHandle(
        '/admin',
        new Request('http://localhost/admin'),
      ),
    )

    expect(matched).toBe(true)
  })

  test('later middleware does not run once one has denied', async () => {
    let reached = false
    const after = () => {
      reached = true
      return undefined
    }

    await withMiddleware([deny, after], () =>
      Promise.resolve(
        MiddlewareHandler.handle(
          '/admin',
          new Request('http://localhost/admin'),
        ),
      ),
    )

    expect(reached).toBe(false)
  })

  test('the status and envelope survive processResponse', async () => {
    // The end-to-end shape the reporter saw: a 401 that arrived as a 404 HTML
    // error page. `processResponse` is what turns the envelope into the wire
    // response, so this is the assertion that pins the reported symptom.
    const req = new Request('http://localhost/admin')
    req.startNs = Bun.nanoseconds()

    const res = await withMiddleware(
      [deny],
      async () =>
        (await processResponse(
          MiddlewareHandler.handle('/admin', req),
          req,
        )) as Response,
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toMatchObject({
      status: 401,
      message: 'Sign in required',
    })
  })

  test('a success envelope stops the chain too', async () => {
    // Not an error-path special case: `canHandle` asks whether middleware
    // answered, not whether it denied.
    const matched = await withMiddleware(
      [() => response.json.success('handled here')],
      () =>
        MiddlewareHandler.canHandle('/x', new Request('http://localhost/x')),
    )

    expect(matched).toBe(true)
  })

  test('a bare object still falls through', async () => {
    // The widening is to `JsonResponseData` specifically, not to "anything
    // truthy" — a middleware that returns a stray value must not halt the
    // chain by accident.
    const matched = await withMiddleware([() => ({ status: 401 }) as any], () =>
      MiddlewareHandler.canHandle('/y', new Request('http://localhost/y')),
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
      MiddlewareHandler.canHandle(
        '/open',
        new Request('http://localhost/open'),
      ),
    )

    expect(matched).toBe(false)
  })
})
