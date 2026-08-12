import { describe, expect, test } from 'bun:test'
import { defineRoute } from './core'
import { html } from './core/jsx'
import type {
  MapOf,
  RouteBody,
  RouteHandler,
  RouteParam,
  RouteResponse,
} from './types'
import { response } from './utils/http'

/**
 * Compile-time pins for the typed route surface (`RouteBody`, `RouteHandler`,
 * `RouteResponse`, `defineRoute`, generic `html`). Most assertions here are
 * type-level: the file failing to *typecheck* is the failure mode, which is why
 * every negative case is a `// @ts-expect-error` — if the error it expects
 * stops happening, tsc reports the unused directive and the core typecheck
 * goes red. Runtime behavior is a single identity check, because that is all
 * the runtime there is.
 */

// --- declared params are typed ---------------------------------------------

const typed = defineRoute<{ id: string }>((req, body) => {
  const id: string = body.id
  // The base stays permissive by design: undeclared keys remain reachable.
  // `body.ts`'s parse rules mean the framework cannot enumerate every key.
  const undeclared = body.anythingElse
  return response.json.success('ok', { id, undeclared, url: req.url })
})

const notAny = defineRoute<{ id: string }>((_req, body) => {
  // @ts-expect-error — a declared param has its declared type, not `any`
  const n: number = body.id
  return n
})

// --- catch-all params are arrays, and RouteParam names the union -----------

// A route that knows its segments declares them exactly: `[id]` binds a
// string, `[...rest]` / `[...rest!]` an array (`[]` for the bare directory).
const catchAll = defineRoute<{ id: string; rest: string[] }>((_req, body) => {
  const joined: string = body.rest.join('/')
  // @ts-expect-error — a catch-all param is segments, not the joined string
  const wrong: string = body.rest
  return response.json.success('ok', { id: body.id, joined, wrong })
})

// A route over mixed or unknown segments writes the union once, by name.
const anySegments = defineRoute<MapOf<RouteParam>>((_req, body) => {
  const segments = Array.isArray(body.slug) ? body.slug : [body.slug]
  return response.json.success('ok', { count: segments.length })
})

// @ts-expect-error — RouteParam is a segment binding, never a number
const notNumeric: RouteParam = 7

// --- the permissive base is RouteBody's contract, not an accident ----------

type LooseBody = RouteBody
const loose: LooseBody = { anything: 1, goes: 'here' }

// --- legacy untyped handlers still assign ----------------------------------

const legacy: RouteHandler = (_req, body) =>
  response.json.success('ok', { echo: body.echo })

// --- the return union stays honest -----------------------------------------

// Everything processResponse actually serves:
defineRoute(() => 'text')
defineRoute(() => 42)
defineRoute(() => ({ plain: 'object' }))
defineRoute(() => [1, 2, 3])
defineRoute(() => null)
defineRoute(() => undefined)
defineRoute(() => new Response('ok'))
defineRoute(() => Bun.file('missing-is-fine-untouched.txt'))
defineRoute(async () => response.json.success('ok'))

// @ts-expect-error — a symbol is nothing processResponse can serve
defineRoute(() => Symbol('nope'))

// RouteResponse is deliberately not `object` (see types.d.ts) — but note that
// `MapOf<any>` still admits class instances (an `any` index signature accepts
// anything), so there is no negative pin here; the union exists for
// legibility, and this positive one for coverage:
const envelope: RouteResponse = response.json.success('ok')

// --- html() is generic the same way ----------------------------------------

const page = html<{ id: string }>((_req, body) => {
  // @ts-expect-error — declared param is `string` inside the render fn too
  const n: number = body.id
  return `<h1>Post ${body.id}${String(n)}</h1>`
})

// Unparameterised call is unchanged — body defaults back to the permissive base.
const plainPage = html((_req, body) => `<p>${body.whatever}</p>`)

describe('defineRoute', () => {
  test('is an identity function', () => {
    const fn: RouteHandler<{ id: string }> = () => null
    expect(defineRoute<{ id: string }>(fn)).toBe(fn)
  })

  test('type-level fixtures are referenced', () => {
    // Referencing the fixtures keeps this file honest under linters; the real
    // assertions above already ran, at compile time.
    expect(
      [typed, notAny, legacy, page, plainPage, catchAll, anySegments].every(
        Boolean,
      ),
    ).toBe(true)
    expect(typeof notNumeric).toBe('number')
    expect(loose.anything).toBe(1)
    // `response.json.*` is *typed* Response but *returns* a JsonResponseData
    // at runtime (a known surface lie, tracked in CLAUDE.md's debt list); both
    // are members of RouteResponse, so the assignment above stays honest.
    expect(envelope).toHaveProperty('status', 200)
  })
})
