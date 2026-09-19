import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import {
  type AppServer,
  bootApp,
  discoverRoutes,
  serverErrors,
} from './support/serve-app'

/**
 * `apps/starter`, requested in production.
 *
 * **This app is where the whole class was first recorded, and it is the one
 * that never got the check.** CLAUDE.md:
 *
 * > "Booted" meant the process started, not that anything was served. Every
 * > `.tsx` page in `apps/starter` returned 500 for an unknown stretch, and
 * > both gates stayed green.
 *
 * The cause is worth restating because it is entirely invisible to a
 * typechecker. Bun's *runtime* does not follow tsconfig `extends` into a
 * **package specifier**, only a relative path — so starter's `jsx`,
 * `jsxFactory` and `jsxFragmentFactory`, inherited from
 * `@bakery-framework/core/tsconfig.server.json`, never reached it. Every
 * `.tsx` route transpiled against Bun's default automatic JSX runtime instead
 * of Bakery's classic `createElement` and answered 500 with `Cannot find
 * module 'react/jsx-dev-runtime'`. `tsc` *does* follow the extends, so the
 * typecheck was clean throughout. `apps/example` was fine the whole time
 * because it extends a relative path.
 *
 * The fix was to repeat the three options inline in `apps/starter/tsconfig.json`,
 * where a comment says why the duplication is load-bearing. This file is what
 * makes that comment enforceable: delete those three lines and these tests go
 * red, which is the property the repo has been missing for the whole life of
 * that bug.
 *
 * Starter exists to use **published entry points only**, so it is also the
 * only place a broken export map shows up as a broken page rather than as a
 * resolution error nobody runs into.
 */
const APP = resolve(import.meta.dir, '../apps/starter')
// Not 3000 (the maintainer's) and not 4600 (the example app's, next door).
const PORT = 4601

let server: AppServer | null = null

beforeAll(async () => {
  server = await bootApp(APP, PORT)
}, 90_000)

afterAll(() => {
  server?.stop()
})

describe('the starter app serves what it ships', () => {
  test('no route answers 5xx', async () => {
    const routes = discoverRoutes(join(APP, 'src'))
    expect(routes.length).toBeGreaterThan(1)
    expect(await serverErrors(server!.base, routes)).toEqual([])
  }, 60_000)

  test('the JSX page renders through Bakery, not a React runtime', async () => {
    // The historical bug, asserted on its symptom rather than its cause. A
    // status check alone is most of it — the failure was a 500 — but the
    // content check is what would also catch a JSX factory that resolved to
    // something else and quietly produced the wrong markup.
    const res = await fetch(`${server!.base}/`)
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(html).toContain('<h1>Bakery starter</h1>')
    expect(html).toContain('<title>Starter</title>')
    // `createElement` composes to a string. A React runtime in its place does
    // not produce markup at all here, it fails to resolve.
    expect(html).not.toContain('jsx-dev-runtime')
  }, 30_000)

  test('its API route answers', async () => {
    // The `.ts` half of the app, which the JSX bug never touched — so this is
    // what tells a JSX regression apart from the app simply being down.
    const res = await fetch(`${server!.base}/api/notes`)
    await res.arrayBuffer()
    expect(res.status).toBeLessThan(500)
  }, 30_000)

  test('its client script compiles and is served', async () => {
    // `src/script.ts` reaches the browser as `/script.js`, through the same
    // compiler the pages use. A transpile that fails here is a page that
    // renders and then does nothing.
    const res = await fetch(`${server!.base}/script.js`)
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toContain('jsx-dev-runtime')
  }, 30_000)
})
