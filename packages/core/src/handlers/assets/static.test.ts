import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  getConfig,
  initConfig,
} from '../../core/config'
import { type HostContext, hostStore } from '../../core/context'
import { withEnvFlag } from '../../tests/fixtures'
import { fs } from '../../utils/fs'
import { getStatic } from '../core/$static'
import { DefaultErrorHandler, StaticHandler } from './static'

beforeAll(async () => {
  await initConfig()
})

/**
 * `DefaultErrorHandler` is the fallback for every path with no more specific
 * error handler, and `errorBody` for a thrown error is the stack — put there
 * by `extractErrorData` for the server log. Rendering it verbatim handed any
 * client source paths and query text in PROD; the body must go through the
 * same `publicBody` gate the rest of the error surface uses.
 */
describe('DefaultErrorHandler — errorBody is redacted like every other error surface', () => {
  const STACKY = {
    errorCode: 500,
    errorText: 'Internal Server Error',
    errorBody: 'Error: kaboom\n    at secretFn (C:/app/src/db.ts:42:7)',
  }

  const render = async (dev: boolean, error: typeof STACKY) => {
    const res = await withEnvFlag('DEV', dev, () =>
      DefaultErrorHandler.handle('/x', new Request('http://localhost/x'), {
        ...error,
      }),
    )
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(error.errorCode)
    return await (res as Response).text()
  }

  test('PROD: a 500 stack never reaches the client', async () => {
    const body = await render(false, STACKY)
    expect(body).not.toContain('secretFn')
    expect(body).not.toContain('db.ts')
    expect(body).toContain('An unexpected error occurred.')
  })

  test('DEV: the stack is shown', async () => {
    const body = await render(true, STACKY)
    expect(body).toContain('secretFn')
  })

  test('a 4xx body is authored, not extracted, and passes through in PROD', async () => {
    const body = await render(false, {
      errorCode: 404,
      errorText: 'Not Found',
      errorBody: 'No page at this address.',
    })
    expect(body).toContain('No page at this address.')
  })
})

describe('StaticHandler.handle — blocked globs', () => {
  afterAll(() => {
    __resetTestConfig()
  })

  test('refuses a blocked path with no request store (direct callers keep the gate)', async () => {
    __setTestConfig({ blocked: new Bun.Glob('{**/decoy.txt}') } as any)
    try {
      const res = await StaticHandler.handle('/decoy.txt')
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(403)
    } finally {
      __resetTestConfig()
    }
  })

  test("reuses the router's verdict recorded on the request store, both ways", async () => {
    __setTestConfig({ blocked: new Bun.Glob('{**/decoy.txt}') } as any)
    try {
      const store: HostContext = {
        config: getConfig(),
        hostname: 'localhost',
        // What the router would have recorded: `true` for a path the globs
        // do NOT match, `false` for one they do. Within a request the
        // recorded verdict is authoritative — that is what makes the
        // handler-side re-check a map hit instead of a second glob match.
        blockedPaths: new Map([
          ['/other.txt', true],
          ['/decoy.txt', false],
        ]),
      }

      await hostStore.run(store, async () => {
        const denied = await StaticHandler.handle('/other.txt')
        expect((denied as Response).status).toBe(403)

        const passed = await StaticHandler.handle('/decoy.txt')
        // Not refused by the memo — it falls through to resolution, where the
        // file genuinely does not exist.
        expect((passed as Response).status).toBe(404)
      })
    } finally {
      __resetTestConfig()
    }
  })
})

/**
 * `getStatic` used to answer "is there a servable file here" with up to three
 * stats per candidate (`fs.exists`, then `fs.isDir` — itself `exists` plus a
 * stat). It now uses one; these pin that the answers did not move.
 */
describe('getStatic — resolution semantics survive the single-stat rewrite', () => {
  const dir = fs.resolve(import.meta.dir, '__fixtures__', 'getstatic')

  beforeAll(async () => {
    await fs.mkdir(fs.resolve(dir, 'sub'))
    await fs.mkdir(fs.resolve(dir, 'hidden'))
    await Bun.write(fs.resolve(dir, 'sub/file.txt'), 'hi')
    await Bun.write(fs.resolve(dir, 'empty.txt'), '')
    await Bun.write(fs.resolve(dir, 'hidden/secret.txt'), 'x')
    await Bun.write(fs.resolve(dir, 'hidden/file.txt'), 'shadowed')
    await Bun.write(fs.resolve(dir, 'hidden/.forbidden'), '')
  })

  afterAll(async () => {
    await fs.rm(fs.resolve(import.meta.dir, '__fixtures__'), {
      recursive: true,
      force: true,
    })
  })

  test('resolves an existing file', async () => {
    const hit = await getStatic('/sub/file.txt', dir)
    expect(hit?.file).toBe(fs.resolve(dir, 'sub/file.txt'))
    expect(hit?.root).toBe(fs.resolve(dir))
    expect(hit?.mounted).toBe(false)
  })

  test('a zero-byte file is still a file', async () => {
    expect((await getStatic('/empty.txt', dir))?.file).toBe(
      fs.resolve(dir, 'empty.txt'),
    )
  })

  test('a directory is not servable', async () => {
    expect(await getStatic('/sub', dir)).toBeNull()
  })

  test('a missing file is null', async () => {
    expect(await getStatic('/nope.txt', dir)).toBeNull()
  })

  test('a path that escapes the root is refused before any stat', async () => {
    expect(await getStatic('/../getstatic-escape.txt', dir)).toBeNull()
  })

  test('a .forbidden marker still hides the subtree', async () => {
    expect(await getStatic('/hidden/secret.txt', dir)).toBeNull()
  })

  test('a forbidden candidate root is skipped, not fatal', async () => {
    // `hidden/file.txt` exists and would win on order, but sits behind the
    // marker; the answer must fall through to the second root.
    const second = fs.resolve(dir, 'sub')
    const hit = await getStatic('/file.txt', [
      fs.resolve(dir, 'hidden'),
      second,
    ])
    expect(hit?.file).toBe(fs.resolve(dir, 'sub/file.txt'))
    expect(hit?.root).toBe(second)
  })
})
