import { describe, expect, test } from 'bun:test'
import { defineRoute } from '../../core/define-route'
import { type StandardSchemaLike, validate } from './validate'

/**
 * A minimal Standard Schema implementation, written here rather than pulled in.
 *
 * The point of the `~standard` interface is that Bakery consumes it without
 * knowing the vendor, so testing against a hand-rolled one is *stronger*
 * evidence than testing against zod: it proves the code depends on the
 * published shape and nothing else. Bakery declares no runtime dependencies and
 * a dev dependency purely for this would undercut the claim it is testing.
 */
function stringField(
  name: string,
): StandardSchemaLike<{ [k: string]: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        const v = value as Record<string, unknown>
        if (typeof v?.[name] !== 'string') {
          return { issues: [{ message: 'expected a string', path: [name] }] }
        }
        return { value: v as { [k: string]: string } }
      },
    },
  }
}

describe('validate', () => {
  test('a Standard Schema pass returns the parsed value', async () => {
    const r = await validate(stringField('title'), { title: 'hi' })
    expect(r).toEqual({ ok: true, value: { title: 'hi' } })
  })

  test('a Standard Schema failure returns path and message', async () => {
    const r = await validate(stringField('title'), { title: 42 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues).toEqual([{ path: 'title', message: 'expected a string' }])
  })

  test('object-form path segments render as keys, not [object Object]', async () => {
    // Standard Schema allows both `'a'` and `{ key: 'a' }` in a path. A naive
    // join renders the second as [object Object] — in the very message meant
    // to say which field is wrong.
    const schema: StandardSchemaLike<unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({
          issues: [{ message: 'bad', path: [{ key: 'user' }, { key: 'id' }] }],
        }),
      },
    }
    const r = await validate(schema, {})
    if (r.ok) throw new Error('expected failure')
    expect(r.issues[0]?.path).toBe('user.id')
  })

  test('an async Standard Schema is awaited', async () => {
    const schema: StandardSchemaLike<number> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async () => ({ value: 7 }),
      },
    }
    expect(await validate(schema, null)).toEqual({ ok: true, value: 7 })
  })

  test('a function validator returns its parsed value', async () => {
    const r = await validate((v: any) => ({ n: Number(v.n) }), { n: '42' })
    expect(r).toEqual({ ok: true, value: { n: 42 } })
  })

  test('a throwing function validator is a rejection, not a crash', async () => {
    // The whole idiom of the plain-function form. The thrown message is what
    // the client sees, so `throw new Error('id required')` reads as written.
    const r = await validate(() => {
      throw new Error('id required')
    }, {})
    expect(r).toEqual({
      ok: false,
      issues: [{ path: '', message: 'id required' }],
    })
  })

  test('a thrown non-Error still yields a message', async () => {
    const r = await validate(() => {
      throw 'nope'
    }, {})
    if (r.ok) throw new Error('expected failure')
    expect(r.issues[0]?.message).toBe('Invalid request body')
  })
})

describe('defineRoute with validation', () => {
  const req = new Request('http://localhost/api/x', { method: 'POST' })

  test('the one-argument form is untouched identity', () => {
    // Every existing route must keep working byte for byte.
    const fn = (_r: Request, b: any) => b
    expect(defineRoute(fn)).toBe(fn)
  })

  test('a valid body reaches the handler', async () => {
    const route = defineRoute(
      { body: stringField('title') },
      (_r, body) => body,
    )
    expect(await route(req, { title: 'ok' } as any)).toEqual({ title: 'ok' })
  })

  test('an invalid body never reaches the handler', async () => {
    let called = false
    const route = defineRoute({ body: stringField('title') }, () => {
      called = true
      return 'unreachable'
    })

    const res: any = await route(req, { title: 1 } as any)
    expect(called).toBe(false)
    // The framework's one JSON envelope, so this looks like every other error.
    expect(res.status).toBe(400)
    expect(res.message).toBe('Invalid request body')
    expect(res.data.issues).toEqual([
      { path: 'title', message: 'expected a string' },
    ])
  })

  test('the handler receives the parsed value, not the raw body', async () => {
    // A schema that coerces is doing so to be used. Passing the original
    // through would make the coercion a lie.
    const route = defineRoute(
      { body: (v: any) => ({ n: Number(v.n) }) },
      (_r, body) => body,
    )
    expect(await route(req, { n: '42' } as any)).toEqual({ n: 42 })
  })
})
