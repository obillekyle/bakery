import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Bakery, hostStore } from './core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  getConfig,
  initConfig,
} from './core/config'
import { StaticHandler } from './handlers/assets/static'
import { ErrorHandler } from './handlers/core/$error'
import { HandlerMap } from './handlers/core/$registry'
import { WebSocketHandler } from './handlers/core/$websocket'
import { ApiHandler } from './handlers/routes/api'
import {
  handleRequest,
  handleRequestError,
  processResponse,
  upgradeWebsocket,
} from './router'
import { injectIfHtml } from './utils/http'

/**
 * The registries are process-wide singletons, so these are swapped for private
 * maps and put back afterwards rather than added to. Restoring the original
 * *instance* (not its entries) also keeps `HandlerMap.routeCache` clean: its
 * keys are prefixed with the map's own id, and a fresh map has a fresh one.
 */
const registries: { fetch: HandlerMap; error: HandlerMap<any> } =
  Bakery.handlers as any
const original = { fetch: registries.fetch, error: registries.error }

beforeAll(async () => {
  await initConfig()

  const fetchMap = new HandlerMap()
  fetchMap.set(ApiHandler, 70)
  fetchMap.set(StaticHandler, 0)
  registries.fetch = fetchMap
  registries.error = new HandlerMap<any>()
})

afterAll(() => {
  registries.fetch = original.fetch
  registries.error = original.error
  __resetTestConfig()
})

const run = <T>(fn: () => Promise<T>) =>
  hostStore.run({ config: getConfig(), hostname: 'localhost' }, fn)

describe('handleRequest', () => {
  test('returns 403 for blocked paths', async () => {
    await run(async () => {
      const res = await handleRequest(new Request('http://localhost:3000/.env'))
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(403)
    })
  })

  test('returns Response for routes', async () => {
    await run(async () => {
      const res = await handleRequest(
        new Request('http://localhost:3000/nonexistent-page-xyz'),
      )
      expect(res !== undefined).toBe(true)
    })
  })

  test('returns Response for forbidden paths', async () => {
    await run(async () => {
      const res = await handleRequest(
        new Request('http://localhost:3000/feetpics'),
      )
      expect(res !== undefined).toBe(true)
    })
  })
})

/**
 * The blocked globs used to be tested against every request path before any
 * handler ran, which made `/api/anything.json` a 403 that no config could undo
 * — `blocked` only ever appends. The glob below is set explicitly so this is a
 * test of the *scope* of the check, not of which extensions happen to be in
 * DEFAULT_BLOCKED_GLOBS.
 */
describe('handleRequest — blocked globs are scoped to file-serving handlers', () => {
  const blocked = { blocked: new Bun.Glob('{**/*.json,**/*.sql,**/.env}') }

  test('an API route is not judged by the blocked globs', async () => {
    __setTestConfig(blocked)
    await run(async () => {
      const res = await handleRequest(
        new Request('http://localhost:3000/api/manifest.json'),
      )
      expect(res).toBeInstanceOf(Response)
      // 404 from ApiHandler ("No API handler found") — the point is that it
      // reached the handler at all instead of being refused before routing.
      expect((res as Response).status).not.toBe(403)
      expect((res as Response).status).toBe(404)
    })
    __resetTestConfig()
  })

  test('a file-serving handler still honours them', async () => {
    __setTestConfig(blocked)
    await run(async () => {
      const res = await handleRequest(
        new Request('http://localhost:3000/manifest.json'),
      )
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(403)
    })
    __resetTestConfig()
  })

  test('dotfiles and source files stay blocked through the static path', async () => {
    __setTestConfig(blocked)
    await run(async () => {
      for (const path of ['/.env', '/config/.env', '/dump.sql']) {
        const res = await handleRequest(
          new Request(`http://localhost:3000${path}`),
        )
        expect((res as Response).status).toBe(403)
      }
    })
    __resetTestConfig()
  })
})

/**
 * `sharedHandler` in routes/html.ts and assets/tsx.ts both end in
 * `injectIfHtml`, which builds its Response with no status — so an app with
 * `src/error-404.html` answered 404s with `200 OK`. The stub below is that
 * shape exactly; the real handlers differ only in where the markup came from.
 */
describe('handleRequestError — the error page carries the error status', () => {
  class HtmlPageErrorHandler extends ErrorHandler {
    static canHandle() {
      return true
    }
    static async handle() {
      const page = await injectIfHtml('<html><body>Not Found</body></html>')
      return page ?? undefined
    }
  }

  test('an injected HTML error page answers with errorCode, not 200', async () => {
    const map = new HandlerMap<any>()
    map.set(HtmlPageErrorHandler, 10)
    registries.error = map

    await run(async () => {
      const res = await handleRequestError(
        '/missing',
        new Request('http://localhost:3000/missing'),
        { errorCode: 404, errorText: 'Not Found', errorBody: 'nope' },
      )
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(404)
      expect(await (res as Response).text()).toContain('Not Found')
    })
  })

  test('the restatused page is still marked injected, so it is not injected twice', async () => {
    const map = new HandlerMap<any>()
    map.set(HtmlPageErrorHandler, 10)
    registries.error = map

    await run(async () => {
      const res = (await handleRequestError(
        '/missing',
        new Request('http://localhost:3000/missing'),
        { errorCode: 404, errorText: 'Not Found', errorBody: 'nope' },
      )) as Response

      const again = await injectIfHtml(res)
      expect(again).toBe(res)

      const body = await res.text()
      expect(body.split('importmap').length - 1).toBe(1)
    })
  })
})

describe('processResponse', () => {
  test('returns 204 Response for null', async () => {
    const req = new Request('http://localhost/')
    ;(req as any).startNs = Bun.nanoseconds()
    const res = await processResponse(null as any, req)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(204)
  })

  test('processes string response', async () => {
    const req = new Request('http://localhost/')
    ;(req as any).startNs = Bun.nanoseconds()
    const res = await processResponse('hello', req)
    expect(res).toBeInstanceOf(Response)
  })
})

/**
 * `upgradeWebsocket` dispatches to `Bakery.handlers.websocket`, whose base
 * `canHandle` returns `true` — so the registry below is the whole framework as
 * far as an upgrade is concerned. WebSockets are exempt from the same-origin
 * policy, which made `/_livereload` reachable from any page the developer
 * happened to have open.
 */
describe('upgradeWebsocket - cross-origin handshakes are refused', () => {
  class OpenSocket extends WebSocketHandler {
    static claimed = 0
    static canHandle() {
      OpenSocket.claimed++
      return true
    }
  }

  const wsRegistry: { websocket: HandlerMap } = Bakery.handlers as any
  const originalWs = wsRegistry.websocket

  const handshake = (headers: Record<string, string> = {}) =>
    new Request('http://localhost:3000/_livereload', {
      headers: { upgrade: 'websocket', ...headers },
    })

  beforeAll(() => {
    const map = new HandlerMap()
    map.set(OpenSocket)
    wsRegistry.websocket = map
  })

  afterAll(() => {
    wsRegistry.websocket = originalWs
  })

  test('an attacker origin never reaches the registry', async () => {
    OpenSocket.claimed = 0
    const upgraded = await upgradeWebsocket(
      handshake({ origin: 'https://evil.example' }),
      '/_livereload',
    )
    expect(upgraded).toBe(false)
    // Refused *before* dispatch, which is what makes every socket inherit the
    // check rather than each handler having to remember it.
    expect(OpenSocket.claimed).toBe(0)
  })

  test("the browser's own origin still dispatches", async () => {
    OpenSocket.claimed = 0
    await upgradeWebsocket(
      handshake({ origin: 'http://localhost:3000' }),
      '/_livereload',
    )
    expect(OpenSocket.claimed).toBe(1)
  })

  test('a client sending no Origin still dispatches', async () => {
    OpenSocket.claimed = 0
    await upgradeWebsocket(handshake(), '/_livereload')
    expect(OpenSocket.claimed).toBe(1)
  })

  test('handleRequest turns the refusal into a failed upgrade', async () => {
    OpenSocket.claimed = 0
    await run(async () => {
      const res = await handleRequest(
        handshake({ origin: 'https://evil.example' }),
      )
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(400)
    })
    // Without the claim count this passes either way: with no server bound,
    // `WebSocketHandler.handle` cannot upgrade and answers 400 regardless.
    expect(OpenSocket.claimed).toBe(0)
  })
})

/**
 * NTFS and APFS are case-insensitive; `Bun.Glob` is not. Every file the
 * blocked list protects was reachable by changing the case of the request
 * path, and the static pipeline was verified serving `/styles/global.css` and
 * `/STYLES/GLOBAL.CSS` as the same bytes.
 */
describe('handleRequest - blocked globs survive a change of case', () => {
  const blocked = {
    blocked: new Bun.Glob('{**/package.json,**/server.config.ts,**/.env}'),
  }

  const status = async (path: string) => {
    const res = await handleRequest(new Request(`http://localhost:3000${path}`))
    return (res as Response).status
  }

  test('case variants are refused like the lower-case path', async () => {
    __setTestConfig(blocked)
    await run(async () => {
      expect(await status('/package.json')).toBe(403)
      expect(await status('/PACKAGE.JSON')).toBe(403)
      expect(await status('/Package.Json')).toBe(403)
      expect(await status('/server.config.ts')).toBe(403)
      expect(await status('/Server.Config.ts')).toBe(403)
      expect(await status('/.ENV')).toBe(403)
    })
    __resetTestConfig()
  })

  test('a trailing dot is refused too, because Win32 strips it', async () => {
    __setTestConfig(blocked)
    await run(async () => {
      expect(await status('/package.json.')).toBe(403)
      expect(await status('/PACKAGE.JSON.')).toBe(403)
    })
    __resetTestConfig()
  })

  test('an app pattern that is not lower-case keeps working', async () => {
    // `initConfig` appends user patterns verbatim, so folding only the path
    // would quietly stop matching the very patterns the app wrote.
    __setTestConfig({ blocked: new Bun.Glob('{**/Secrets.txt}') })
    await run(async () => {
      expect(await status('/Secrets.txt')).toBe(403)
    })
    __resetTestConfig()
  })
})

/**
 * `config.onError` is application code, and the sibling call to the error
 * registry two lines below it has always been wrapped. Unwrapped, a throwing
 * `onError` escaped `Try.return`'s fallback in the caller -- a fallback that
 * itself rejects is not a fallback -- and the client got Bun's raw 500 instead
 * of the app's error page.
 */
describe('handleRequestError - a throwing config.onError does not escape', () => {
  test('the error page is still produced', async () => {
    __setTestConfig({
      onError() {
        throw new Error('onError exploded')
      },
    } as any)

    const map = new HandlerMap<any>()
    registries.error = map

    await run(async () => {
      const res = await handleRequestError(
        '/boom',
        new Request('http://localhost:3000/boom'),
        { errorCode: 500, errorText: 'Internal', errorBody: 'nope' },
      )
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(500)
      expect(await (res as Response).text()).toContain('Internal')
    })

    __resetTestConfig()
  })
})
