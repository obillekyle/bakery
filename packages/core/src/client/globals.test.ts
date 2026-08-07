import { describe, expect, test } from 'bun:test'
import { Case } from '../utils/isomorphic/case'
import { Try } from '../utils/isomorphic/try'
import { randomId, request } from './utils'

/**
 * Compile-time pins for the browser globals declared in `globals.d.ts`.
 *
 * That file used to hand-write each global's shape, and four of them had
 * drifted from the implementation — silently, because a `.d.ts` restating a
 * signature is never checked against the code it claims to describe. The
 * declarations are now `typeof import(...)` queries, and these pins are what
 * fails if anyone restates one by hand again.
 *
 * Most assertions here are type-level, exactly like `route-types.test.ts`: the
 * file failing to *typecheck* is the failure mode, which is why the negative
 * cases are `// @ts-expect-error` — if the error stops happening, tsc reports
 * the unused directive and the core typecheck goes red. The runtime block below
 * pins the one fact the types are derived from: `Try.throw` really is async.
 */

// Never called — these exist to be typechecked, not run. The globals are bound
// by `client/utils.ts` in a browser; this process has no `globalThis.Try`.
//
// Every probe goes through `globalThis.` deliberately. Writing bare `Try` here
// would resolve to the import above and pin the *implementation*, which was
// never in doubt — the drift was in the ambient declaration, so the ambient
// declaration is what has to be named.
function _globalTypeProbes() {
  // --- Try.throw is always a Promise -----------------------------------------

  // @ts-expect-error — tryThrow is `Promise.try(...).catch(...)`; there is no
  // synchronous overload, and the declaration used to claim one.
  const sync: number = globalThis.Try.throw(() => 1)

  const asyncOk: Promise<number> = globalThis.Try.throw(() => 1)
  const asyncFromPromise: Promise<number> = globalThis.Try.throw(async () => 1)

  // --- Case keeps its callable form ------------------------------------------

  const called: string = globalThis.Case('kebab', 'someString')
  const method: string = globalThis.Case.kebab('someString')

  // @ts-expect-error — 'shouty' is not a CaseType
  const badCase: string = globalThis.Case('shouty', 'x')

  // --- request takes an object init, not just (url, method, body) ------------

  const withInit = globalThis.request('/x', {
    method: 'POST',
    headers: { a: 'b' },
  })
  const withMethod = globalThis.request('/x', 'POST', { a: 1 })

  // --- randomId takes a length -----------------------------------------------

  const sized: string = globalThis.randomId(16)
  const defaulted: string = globalThis.randomId()

  return [
    sync,
    asyncOk,
    asyncFromPromise,
    called,
    method,
    badCase,
    withInit,
    withMethod,
    sized,
    defaulted,
  ]
}

describe('browser globals match their implementations', () => {
  test('Try.throw returns a Promise even for a synchronous callback', async () => {
    // The fact the removed synchronous overload contradicted.
    const result = Try.throw(() => 1)
    expect(result).toBeInstanceOf(Promise)
    expect(await result).toBe(1)
  })

  test('Case is callable as well as keyed', () => {
    expect(Case('kebab', 'someString')).toBe(Case.kebab('someString'))
  })

  test('randomId honours its length argument', () => {
    expect(randomId(16)).toHaveLength(16)
    expect(randomId()).toHaveLength(8)
  })

  test('type-level probe is referenced', () => {
    expect(typeof _globalTypeProbes).toBe('function')
  })
})
