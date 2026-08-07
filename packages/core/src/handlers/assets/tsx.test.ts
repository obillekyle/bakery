import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { __resetTestConfig, __setTestConfig, initConfig } from '../../core/config'
import { JsonResponseData } from '../../utils/common'
import { fs } from '../../utils'
import { TSXHandler } from './tsx'

/**
 * A throwaway serve root, so the handler resolves and imports a real module the
 * way it does in production rather than through a stub. `.cache/` is
 * gitignored and is where the mount tests keep their fixtures too.
 */
const APP_DIR = fs.resolve(process.cwd(), '.cache/__tsx-test__')

/**
 * The fixture imports `createElement` explicitly. In a running app it is a
 * global bound by core/init.ts, which no test loads; the import produces the
 * same SafeHtml either way, which is the whole point of the fixture.
 */
const JSX_IMPORT = "import { createElement } from '../../packages/core/src/core/jsx'"

beforeAll(async () => {
  await initConfig()

  await Bun.write(
    `${APP_DIR}/index.tsx`,
    `${JSX_IMPORT}

export default function Home() {
  return (
    <html lang="en">
      <head><title>Fixture</title></head>
      <body><h1>bakery fixture</h1></body>
    </html>
  )
}
`,
  )

  await Bun.write(
    `${APP_DIR}/data.tsx`,
    `export default function Data() {
  return { ok: true }
}
`,
  )

  // Written here, not in its test: Bun's resolver will not see a file that
  // first appears after this directory has already been imported from.
  await Bun.write(
    `${APP_DIR}/edited.tsx`,
    `${JSX_IMPORT}\n\nexport default () => <h1>before edit</h1>\n`,
  )

  __setTestConfig({ root: APP_DIR })
  TSXHandler.initRoutes()
})

afterAll(async () => {
  TSXHandler.initRoutes()
  __resetTestConfig()
  await rm(APP_DIR, { recursive: true, force: true })
})

describe('TSXHandler', () => {
  test('an unwrapped JSX page is served as HTML, not JSON', async () => {
    // `createElement` returns raw() -> SafeHtml, a String *subclass*, so
    // `is.object` (typeof === 'object') was true for it and the page went out
    // as {"status":200,...,"data":"<html ..."}. apps/starter hit exactly this
    // on GET /.
    const res = (await TSXHandler.handle(
      '/',
      new Request('http://localhost/'),
    )) as Response

    expect(res).toBeInstanceOf(Response)
    expect(res).not.toBeInstanceOf(JsonResponseData)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')

    const body = await res.text()
    expect(body).toContain('<h1>bakery fixture</h1>')
    expect(body).not.toContain('"status":200')
  })

  test('a route returning a plain object is still JSON', async () => {
    // The fix must not swallow the object branch: only SafeHtml is unboxed.
    const res = await TSXHandler.handle('/data', new Request('http://localhost/data'))

    expect(res).toBeInstanceOf(JsonResponseData)
    expect((res as JsonResponseData).data).toEqual({ ok: true })
  })

  test('an edited page serves the new content without a restart', async () => {
    // `.tsx` edits used to force a full dev-process restart because Bun's
    // module registry caches the imported route module. TSXHandler now busts
    // the registry with `?v=<mtime>` outside PROD, exactly like ApiHandler, so
    // the second request below must see the edit within the same process.
    const page = `${APP_DIR}/edited.tsx`

    const first = (await TSXHandler.handle(
      '/edited',
      new Request('http://localhost/edited'),
    )) as Response
    expect(await first.text()).toContain('before edit')

    // NTFS mtime resolution is 100ns, but give the two writes a visibly
    // distinct timestamp so the buster cannot collide.
    await Bun.sleep(15)
    await Bun.write(
      page,
      `${JSX_IMPORT}\n\nexport default () => <h1>after edit</h1>\n`,
    )
    // The cheap dev path flushes route caches on every .ts/.tsx change; the
    // route *info* was never the stale part, but mirror it for fidelity.
    TSXHandler.initRoutes()

    const second = (await TSXHandler.handle(
      '/edited',
      new Request('http://localhost/edited'),
    )) as Response
    expect(await second.text()).toContain('after edit')
  })
})
