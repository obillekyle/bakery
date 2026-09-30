import { describe, expect, test } from 'bun:test'
import { getServerResponse } from './utils'

/**
 * A `<script server>` block that declares a guard fails closed when it throws.
 *
 * The generated wrapper runs the block's top-level statements and *then*
 * calls `middleware`, so a throw anywhere above skips the guard entirely.
 * `getServerResponse` used to swallow that into `{}`, and the route served:
 * an `/admin/*` page answering 200 to an anonymous caller because a query
 * threw. The cause does not have to be exotic. The block only has to throw,
 * so a database being down, a null deref or a typo all reach it.
 *
 * Convention 2 names this shape: a guard "returns the rejection, not `null`,
 * on any indeterminate state". A guard that ceased to exist is the most
 * indeterminate state available.
 *
 * The declaration is read from the **source**, because there is no result to
 * read it from: the module threw before its exports existed.
 */
const MOD = 1_700_000_000_000
let seq = 0
const nextId = () => `guardfc-${process.pid}-${seq++}`

function run(script: string) {
  return getServerResponse({
    script,
    id: nextId(),
    lastMod: MOD,
    req: new Request('http://localhost/admin/home'),
    body: {},
  })
}

describe('a throwing server block that declares a guard', () => {
  test('fails closed with a 500 rather than serving the route', async () => {
    const res = await run(`
      const role = (null as any).session.get('role')
      export async function middleware() {
        if (role !== 'admin') return new Response(null, { status: 302 })
      }
    `)
    // Asserted on the type, not on JSON: \`JSON.stringify(new Response())\` is
    // \`{}\`, which is exactly what the broken behavior returned. A probe
    // written that way reported this as still failing after it was fixed.
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(500)
  })

  test('the guard being late in the block does not matter', async () => {
    // The throw is what skips it, not where the declaration sits.
    const res = await run(`
      export const rows = [1, 2]
      const boom = (null as any).nope
      export async function middleware() { return new Response(null, { status: 302 }) }
    `)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(500)
  })
})

describe('a guarded block that fails to load', () => {
  // One step earlier than a throw: the module never loads, so there is no
  // wrapper to run and no guard inside it. `getServerResponse` answered `{}`
  // on that path while the rule above covered only a block that throws while
  // running, so a guarded page that failed to load was served to anyone.

  test('fails closed when the block redeclares `req`', async () => {
    // The realistic cause. `req` is the compiled wrapper's own parameter, so
    // a top-level `const req = getRequest()` does not compile, and it reads
    // as correct in an editor, which sees the block as a module.
    const res = await run(`
      const req = 1
      export async function middleware() {
        return new Response(null, { status: 302 })
      }
    `)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(500)
  })

  test('fails closed when an import does not resolve', async () => {
    const res = await run(`
      import { nothing } from './no-such-module-${process.pid}'
      export async function middleware() {
        return new Response(null, { status: 302 })
      }
      export const x = nothing
    `)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(500)
  })
})

describe('what deliberately did not change', () => {
  test('a data-only block that fails to load still renders with no data', async () => {
    // The same line as a data-only block that throws, below: nothing was
    // protecting the route, and an empty page is a visible failure.
    const res = await run(`const req = 1\nexport const rows = [1]`)
    expect(res).not.toBeInstanceOf(Response)
    expect(res).toEqual({})
  })

  test('a data-only block that throws still renders the page with no data', async () => {
    // The documented behavior, and the right one: nothing was protecting this
    // route, and a page that renders empty is a visible failure rather than a
    // silent one.
    const res = await run(`const x = (null as any).boom\nexport const rows = x`)
    expect(res).not.toBeInstanceOf(Response)
    expect(res).toEqual({})
  })

  test('a guard that does not throw is untouched', async () => {
    const res = await run(`
      export async function middleware() { return undefined }
      export const rows = [1, 2, 3]
    `)
    expect(res).not.toBeInstanceOf(Response)
    expect((res as { rows?: number[] }).rows).toEqual([1, 2, 3])
  })
})
