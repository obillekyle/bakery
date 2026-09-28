import { describe, expect, test } from 'bun:test'
import { getRequest, hostStore } from './context'

/**
 * `getRequest()` exists so a file does not need an ambient declaration to
 * reach the request.
 *
 * The Vue plugin declared `var req: Request` in `plugin-vue/src/vue.d.ts`,
 * which reaches a file only if that `.d.ts` lands in whatever tsconfig
 * project the editor resolves for it. For an SFC it routinely does not: the
 * generated project naming it sits under `.cache/tsconfig/`, which is not an
 * ancestor of `src/`, so no editor picks it. The symptom was `req`
 * unresolved and `req.session` missing, with nothing obvious to point at.
 *
 * An import cannot fail that way, which is the entire argument for this
 * function over the global.
 */

const config = {} as Readonly<ProcessedAppConfig>

describe('getRequest', () => {
  test('returns the request the store was entered with', () => {
    const req = new Request('https://example.test/page')
    const seen = hostStore.run({ config, hostname: 'example.test', req }, () =>
      getRequest(),
    )
    expect(seen).toBe(req)
  })

  test('survives an await, which a wrapper parameter does not travel past', async () => {
    // The case the ambient global could not serve at all: a helper called by
    // a server block, in another file, after an await.
    const req = new Request('https://example.test/deep')
    const helper = async () => {
      await Bun.sleep(1)
      return getRequest()
    }
    const seen = await hostStore.run(
      { config, hostname: 'example.test', req },
      () => helper(),
    )
    expect(seen).toBe(req)
  })

  test('two concurrent requests do not see each other', async () => {
    // AsyncLocalStorage is the whole safety argument for reading a per-request
    // value from a module-level function; if this ever fails, the function is
    // a cross-request leak rather than a convenience.
    const a = new Request('https://example.test/a')
    const b = new Request('https://example.test/b')

    const run = (req: Request, delay: number) =>
      hostStore.run({ config, hostname: 'example.test', req }, async () => {
        await Bun.sleep(delay)
        return getRequest()
      })

    const [seenA, seenB] = await Promise.all([run(a, 8), run(b, 1)])
    expect(seenA).toBe(a)
    expect(seenB).toBe(b)
  })

  test('throws outside a request rather than returning undefined', () => {
    // Two real cases reach here and neither is application code that meant to
    // ask: a WebSocket event (which has `ws.data`, not a Request) and
    // boot-time code. Returning `undefined` would push a null check into
    // every call site to serve two situations that are bugs.
    expect(() => getRequest()).toThrow(/outside a request/)
  })

  test('throws inside a store that carries no request', () => {
    // `router.ts` enters the store for a WebSocket event with no `req`, so
    // "there is a store" and "there is a request" are genuinely different
    // states and the check has to test the second one.
    expect(() =>
      hostStore.run({ config, hostname: 'example.test' }, () => getRequest()),
    ).toThrow(/outside a request/)
  })
})
