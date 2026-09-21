import { describe, expect, test } from 'bun:test'
// `./core/bakery` re-exports `hostStore` and is an enumerated subpath;
// `./core/context` is not, and adding it would widen the published
// surface for a test.
import { hostStore } from '@bakery-framework/core/core/bakery'
import { getBody } from './server-context'
import { getServerResponse } from './utils'

/**
 * `getRequest()` and `getBody()` reaching a real `<script server>` block.
 *
 * The unit tests in core prove the store behaves; this proves the plugin
 * actually runs the block inside it, which is the part that could silently
 * regress. It compiles and imports a generated module exactly as a request
 * does, rather than asserting on the wiring from the outside.
 *
 * Why these exist at all: the block used to reach `req` and `body` as globals
 * declared in `vue.d.ts`, and that declaration reaches a file only when the
 * `.d.ts` lands in whatever tsconfig project an editor resolves for the SFC.
 * For an SFC it routinely does not, because the generated project naming it
 * lives under `.cache/tsconfig/`, which is not an ancestor of `src/`.
 *
 * The globals still work. Both mechanisms are exercised below, because
 * keeping the wrapper parameters is what makes this additive rather than a
 * breaking change for every existing block.
 */

/**
 * Absolute source paths, not the bare specifiers an app would write.
 *
 * The generated module lands in `.cache/vue/server/`, and this repo has no
 * `node_modules/@bakery-framework` at all: every `@bakery-framework/*`
 * specifier here resolves through tsconfig `paths`, which a runtime import
 * from that directory does not consult. A consumer app has the real
 * directory and the ordinary walk up from `.cache/` finds it, so the bare
 * form works there and is what the docs should show. Same class of thing as
 * the export maps: what a consumer resolves is not observable from in here.
 */
const CORE = Bun.pathToFileURL(
  `${import.meta.dir}/../../../core/src/core/context.ts`,
).href
const PLUGIN = Bun.pathToFileURL(`${import.meta.dir}/server-context.ts`).href

const config = {} as Readonly<ProcessedAppConfig>
const MOD = 1_700_000_000_000

/** One id per test: the generated module is cached by `id`_`lastMod`. */
let seq = 0
const nextId = () => `srvctx-${process.pid}-${seq++}`

function inRequest<T>(req: Request, fn: () => Promise<T>): Promise<T> {
  return hostStore.run({ config, hostname: 'localhost', req }, fn)
}

describe('a server block reaches the request without an ambient global', () => {
  test('getRequest() resolves inside the block', async () => {
    const req = new Request('http://localhost/orders?id=7')
    const res = await inRequest(req, () =>
      getServerResponse({
        script: `
          import { getRequest } from '${CORE}'
          export const seenUrl = getRequest().url
        `,
        id: nextId(),
        lastMod: MOD,
        req,
        body: {},
      }),
    )
    expect((res as { seenUrl?: string }).seenUrl).toBe(
      'http://localhost/orders?id=7',
    )
  })

  test('getRequest().session is typed and present, which the global got wrong', async () => {
    // The ambient said `req: Request` while the wrapper parameter is `any`,
    // so the promise and the runtime disagreed. `session` is the augmentation
    // people actually reach for and the one that was missing.
    const req = new Request('http://localhost/account')
    Object.defineProperty(req, 'session', {
      value: { get: (k: string) => (k === 'uid' ? 42 : undefined) },
      configurable: true,
    })

    const res = await inRequest(req, () =>
      getServerResponse({
        script: `
          import { getRequest } from '${CORE}'
          export const uid = getRequest().session.get('uid')
        `,
        id: nextId(),
        lastMod: MOD,
        req,
        body: {},
      }),
    )
    expect((res as { uid?: number }).uid).toBe(42)
  })

  test('getBody() resolves inside the block', async () => {
    const req = new Request('http://localhost/save', { method: 'POST' })
    const res = await inRequest(req, () =>
      getServerResponse({
        script: `
          import { getBody } from '${PLUGIN}'
          export const name = getBody().name
        `,
        id: nextId(),
        lastMod: MOD,
        req,
        body: { name: 'from the body' },
      }),
    )
    expect((res as { name?: string }).name).toBe('from the body')
  })

  test('both reach a helper the block calls, which a parameter cannot', async () => {
    // The capability the globals never had: a wrapper parameter stops at the
    // wrapper, so a helper had to have `req` threaded into it by hand.
    const req = new Request('http://localhost/deep')
    const res = await inRequest(req, () =>
      getServerResponse({
        script: `
          import { getRequest } from '${CORE}'
          import { getBody } from '${PLUGIN}'
          async function helper() {
            await new Promise(r => setTimeout(r, 1))
            return getRequest().url + '|' + getBody().tag
          }
          export const combined = await helper()
        `,
        id: nextId(),
        lastMod: MOD,
        req,
        body: { tag: 'deep' },
      }),
    )
    expect((res as { combined?: string }).combined).toBe(
      'http://localhost/deep|deep',
    )
  })

  test('the req and body parameters still work, so nothing existing breaks', async () => {
    const req = new Request('http://localhost/legacy')
    const res = await inRequest(req, () =>
      getServerResponse({
        script: `export const both = req.url + '|' + body.tag`,
        id: nextId(),
        lastMod: MOD,
        req,
        body: { tag: 'legacy' },
      }),
    )
    expect((res as { both?: string }).both).toBe(
      'http://localhost/legacy|legacy',
    )
  })

  test('getBody() outside a block is undefined, not a throw', async () => {
    // Unlike getRequest(): a GET with no payload and no route params is an
    // ordinary request, so absence is an answer rather than an error.
    expect(getBody()).toBeUndefined()
  })
})
