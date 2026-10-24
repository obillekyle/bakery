import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { Bakery, hostStore } from '../core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  clearHostConfigCache,
  initConfig,
  resolveHostConfig,
} from '../core/config'
import { StaticHandler } from '../handlers/assets/static'
import { TSHandler } from '../handlers/assets/ts'
import { clearMounts, mountRoutes } from '../handlers/core/$mounts'
import { HandlerMap } from '../handlers/core/$registry'
import { ApiHandler } from '../handlers/routes/api'
import { HTMLErrorHandler, HTMLHandler } from '../handlers/routes/html'
import {
  handleRequest,
  handleRequestError,
  processResponse,
  routeOf,
} from '../router'
import { fs } from '../utils/fs'

/**
 * `hostMounts` through the real router: a host serving the app's `/kit` at
 * its root, beside a host that serves the app as it is.
 *
 * The line under test is which requests move into the subtree. Pages do: a
 * navigation, or any method but GET and HEAD. What a page loads does not,
 * and the case that decides it is a module imported without an extension,
 * `/kit/useDemo`, which nothing in the path tells apart from a page.
 *
 * Registries are swapped for private maps, as `router.test.ts` and plugin-vue's
 * `catch-all-assets.test.ts` do, and a 404 goes to the error registry the way
 * `cli/src/worker.ts` sends it, so an error page is looked up from the path
 * routing resolved.
 */
const ROOT = fs.resolve(process.cwd(), '.cache', '__host-mount-routing__')

const page = (marker: string) =>
  `<!DOCTYPE html><html><head><title>${marker}</title></head><body><p>${marker}</p></body></html>`

const FILES: Record<string, string> = {
  'index.html': page('root home'),
  'guide.html': page('root guide'),
  'error-404.html': page('root not found'),
  'kit/index.html': page('kit home'),
  'kit/guide.html': page('kit guide'),
  'kit/error-404.html': page('kit not found'),
  'kit/useDemo.ts': "export const demo = 'kit module'\n",
  'ui/useThing.ts': "export const thing = 'ui module'\n",
  'styles/site.css': '.root-css { color: teal; }\n',
  'api/hello.ts':
    "export default () => new Response('root api', { headers: { 'content-type': 'text/plain' } })\n",
  'plugin/panel.css': '.plugin { color: red; }\n',
}

const registries: { fetch: HandlerMap; error: HandlerMap<any> } =
  Bakery.handlers as any
const original = { fetch: registries.fetch, error: registries.error }

beforeAll(async () => {
  clearHostConfigCache()
  await initConfig()
  for (const [file, text] of Object.entries(FILES)) {
    await Bun.write(`${ROOT}/${file}`, text)
  }
  __setTestConfig({
    root: ROOT,
    // `docs` is a hosts entry with a mount, under localhost, which always
    // counts as a domain; its `hostMounts` pattern says otherwise and loses.
    hosts: { docs: { mount: '/kit' } },
    hostMounts: [
      { host: 'kit.*', path: '/kit' },
      { host: 'docs.*', path: '/elsewhere' },
    ],
    proxy: { '/legacy': 'http://127.0.0.1:9' },
  } as any)
  mountRoutes('/plugin-assets', `${ROOT}/plugin`)

  const fetchMap = new HandlerMap()
  fetchMap.set(ApiHandler, 70)
  fetchMap.set(HTMLHandler, 55)
  fetchMap.set(TSHandler, 50)
  fetchMap.set(StaticHandler, 0)
  registries.fetch = fetchMap
  const errorMap = new HandlerMap<any>()
  errorMap.set(HTMLErrorHandler, 10)
  registries.error = errorMap
})

afterAll(async () => {
  registries.fetch = original.fetch
  registries.error = original.error
  clearMounts()
  __resetTestConfig()
  clearHostConfigCache()
  await rm(ROOT, { recursive: true, force: true })
})

/** What a browser sends for each kind of request, and what a bare client does. */
const KINDS = {
  navigate: {
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  },
  /** A browser with no Fetch Metadata loading a page. */
  html: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  module: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script', accept: '*/*' },
  plain: { accept: '*/*' },
} satisfies Record<string, Record<string, string>>

function request(
  host: string,
  path: string,
  kind: keyof typeof KINDS,
  init: RequestInit = {},
): Request {
  return new Request(`http://${host}${path}`, {
    ...init,
    headers: { ...KINDS[kind], ...(init.headers as any) },
  })
}

/** A request the way `cli/src/worker.ts` serves one, in its host's config. */
function serve(req: Request): Promise<Response> {
  const hostname = new URL(req.url).hostname
  const config = resolveHostConfig(hostname)
  return hostStore.run({ config, hostname, req }, async () => {
    let res: any = await handleRequest(req)
    if (res instanceof Response && res.status === 404) {
      res = await handleRequestError(routeOf(req).path, req, res)
    }
    return (await processResponse(res, req)) as Response
  })
}

const text = async (
  host: string,
  path: string,
  kind: keyof typeof KINDS,
): Promise<string> => {
  const res = await serve(request(host, path, kind))
  return `${res.status} ${await res.text()}`
}

describe('on a mounted host, pages come from the subtree', () => {
  test('the host root is the mount, and a path is the path under it', async () => {
    const home = await text('kit.localhost', '/', 'navigate')
    expect(home.startsWith('200 ')).toBe(true)
    expect(home).toContain('<p>kit home</p>')
    expect(await text('kit.localhost', '/guide', 'navigate')).toContain(
      '<p>kit guide</p>',
    )
  })

  test('a browser that sends no Fetch Metadata is navigating when it asks for HTML', async () => {
    expect(await text('kit.localhost', '/guide', 'html')).toContain(
      '<p>kit guide</p>',
    )
  })

  test('whatever the domain, the case or the port', async () => {
    expect(await text('kit.bpc.edu.ph', '/guide', 'navigate')).toContain(
      '<p>kit guide</p>',
    )
    const res = await serve(
      request('kit.localhost', '/guide', 'navigate', {
        headers: { host: 'KIT.Localhost:3000' },
      }),
    )
    expect(await res.text()).toContain('<p>kit guide</p>')
  })

  test('an error page is looked up from the subtree', async () => {
    expect(await text('kit.localhost', '/missing', 'navigate')).toContain(
      '<p>kit not found</p>',
    )
    expect(await text('admin.localhost', '/missing', 'navigate')).toContain(
      '<p>root not found</p>',
    )
  })
})

describe('on a mounted host, what pages load comes from the root', () => {
  test('a module imported without an extension, in the subtree or out of it', async () => {
    const own = await serve(request('kit.localhost', '/kit/useDemo', 'module'))
    expect(own.status).toBe(200)
    expect(await own.text()).toContain('kit module')

    const shared = await serve(request('kit.localhost', '/ui/useThing', 'module'))
    expect(shared.status).toBe(200)
    expect(await shared.text()).toContain('ui module')
  })

  test('a GET that is no navigation keeps its path', async () => {
    expect(await text('kit.localhost', '/guide', 'plain')).toContain(
      '<p>root guide</p>',
    )
  })

  test('a navigation to a file, the API or a plugin route reaches it at the root', async () => {
    expect(await text('kit.localhost', '/styles/site.css', 'navigate')).toBe(
      `200 ${FILES['styles/site.css']}`,
    )
    expect(await text('kit.localhost', '/api/hello', 'navigate')).toBe(
      '200 root api',
    )
    expect(
      await text('kit.localhost', '/plugin-assets/panel.css', 'navigate'),
    ).toBe(`200 ${FILES['plugin/panel.css']}`)
  })
})

describe('a host no mount serves is untouched', () => {
  test('its pages are the app as it is, the subtree under its own path', async () => {
    expect(await text('admin.localhost', '/', 'navigate')).toContain(
      '<p>root home</p>',
    )
    expect(await text('admin.localhost', '/kit/guide', 'navigate')).toContain(
      '<p>kit guide</p>',
    )
  })

  test('and its answers carry no Vary for it', async () => {
    const res = await serve(request('admin.localhost', '/guide', 'navigate'))
    expect(res.headers.get('Vary') ?? '').not.toContain('Sec-Fetch-Mode')
  })
})

describe('Vary', () => {
  test('a path that answers by request kind says so, either way it went', async () => {
    for (const kind of ['navigate', 'plain'] as const) {
      const res = await serve(request('kit.localhost', '/guide', kind))
      await res.arrayBuffer()
      const vary = res.headers.get('Vary') ?? ''
      expect(`${kind}: ${vary}`).toContain('Sec-Fetch-Mode')
      expect(`${kind}: ${vary}`).toContain('Accept')
    }
  })

  test('a file answers the same to every request, and does not', async () => {
    const res = await serve(
      request('kit.localhost', '/styles/site.css', 'navigate'),
    )
    await res.arrayBuffer()
    expect(res.headers.get('Vary') ?? '').not.toContain('Sec-Fetch-Mode')
  })
})

describe("a hosts entry's mount", () => {
  test('moves page requests the same way, and wins over a hostMounts pattern', async () => {
    expect(await text('docs.localhost', '/', 'navigate')).toContain(
      '<p>kit home</p>',
    )
    expect(await text('docs.localhost', '/guide', 'navigate')).toContain(
      '<p>kit guide</p>',
    )
  })

  test('and leaves what pages load at the root', async () => {
    const own = await serve(request('docs.localhost', '/kit/useDemo', 'module'))
    expect(own.status).toBe(200)
    expect(await own.text()).toContain('kit module')
    expect(await text('docs.localhost', '/guide', 'plain')).toContain(
      '<p>root guide</p>',
    )
  })
})

describe('routeOf', () => {
  const route = (req: Request) => {
    const hostname = new URL(req.url).hostname
    return hostStore.run(
      { config: resolveHostConfig(hostname), hostname, req },
      () => routeOf(req),
    )
  }

  test('a navigation moves into the mount, which is reported', () => {
    expect(route(request('kit.localhost', '/forms', 'navigate'))).toEqual({
      path: '/kit/forms',
      mount: '/kit',
      varies: true,
    } as any)
  })

  test('a form post or a server action moves, whatever it accepts', () => {
    const post = request('kit.localhost', '/forms?__vue_action=save', 'plain', {
      method: 'POST',
    })
    expect(route(post).path).toBe('/kit/forms')
  })

  test('a WebSocket upgrade, a framework route and RFC 8615 metadata stay', () => {
    const upgrade = request('kit.localhost', '/live', 'plain', {
      headers: { upgrade: 'websocket', 'sec-fetch-mode': 'websocket' },
    })
    expect(route(upgrade).path).toBe('/live')
    expect(route(request('kit.localhost', '/_dashboard', 'navigate')).path).toBe(
      '/_dashboard',
    )
    expect(
      route(request('kit.localhost', '/.well-known/acme-challenge/t', 'navigate'))
        .path,
    ).toBe('/.well-known/acme-challenge/t')
  })

  test('a proxied prefix stays, so the proxy still answers it', () => {
    expect(route(request('kit.localhost', '/legacy/x', 'navigate')).path).toBe(
      '/legacy/x',
    )
  })

  test('on a host no mount serves, the path is the request path', () => {
    const req = request('admin.localhost', '/forms', 'navigate')
    expect(route(req)).toEqual({
      path: '/forms',
      mount: null,
      varies: false,
    } as any)
  })

  test('is worked out once per request', () => {
    const req = request('kit.localhost', '/forms', 'navigate')
    expect(route(req)).toBe(route(req))
  })
})
