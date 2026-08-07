import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../../core/config'
import { fs } from '../../utils/fs'
import { ErrorHandler } from '../core/$error'
import { ApiErrorHandler, ApiHandler } from './api'

/**
 * `import.meta.env.DEV` is a getter on `process.env` installed by `core/init`,
 * so it is swapped by descriptor and put back — not assigned to, which throws
 * once init has defined the getter, and not module-mocked, which never
 * unwinds.
 */
function withEnvFlag<T>(flag: string, value: unknown, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.env, flag)
  Object.defineProperty(process.env, flag, {
    get: () => value,
    configurable: true,
  })

  try {
    return fn()
  } finally {
    if (original) Object.defineProperty(process.env, flag, original)
    else delete (process.env as any)[flag]
  }
}

const asDev = <T>(fn: () => T): T => withEnvFlag('DEV', true, fn)
// PROD alone is not enough: init.ts defaults PROD to true without `--dev`,
// so the production gate is `PROD && !TEST` — and under `bun test` the TEST
// flag is genuinely on once init has loaded. Simulating production means
// forcing both.
const asProd = <T>(fn: () => T): T =>
  withEnvFlag('PROD', true, () => withEnvFlag('TEST', false, fn))

const req = () => new Request('http://localhost/api/students')

describe('ApiHandler.executeModule', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(dir => rm(dir, { recursive: true })),
    )
  })

  test('PROD imports the bare specifier and hits the module registry cache', async () => {
    // In DEV (and in tests, where neither flag is set) the specifier carries
    // `?v=<mtime>` so an edited route re-imports fresh; that behavior is
    // pinned by tests/api-isolation.test.ts. In PROD the mtime stat is a
    // per-request cost for files that cannot change, so the bare specifier is
    // imported once and the second read must come from Bun's registry cache.
    const dir = await mkdtemp(join(tmpdir(), 'bakery-api-prod-'))
    directories.push(dir)
    const file = join(dir, 'handler.ts')
    const request = req()

    await writeFile(file, "export default () => 'first'")
    const first = await asProd(() =>
      ApiHandler.executeModule(file as any, request, null),
    )
    expect(first).toBe('first')

    await new Promise(resolve => setTimeout(resolve, 10))
    await writeFile(file, "export default () => 'second'")
    const second = await asProd(() =>
      ApiHandler.executeModule(file as any, request, null),
    )
    expect(second).toBe('first')
  })
})

/**
 * `null` out of `executeModule` had exactly one meaning, and `handle` answered
 * it with the wrong one.
 *
 * An import that *fails* — a syntax error, an unresolvable specifier — already
 * throws from `$dynamic.ts` and becomes a 500. So the only way to reach `null`
 * is a module that loaded cleanly and exports no default: the file is on disk,
 * the router found it, and it was answered with a 404 that named nothing. The
 * developer is sent looking for a file that is right there.
 */
const API_ROOT = fs.resolve(process.cwd(), '.cache/__api-test__')

describe('ApiHandler.handle — a module that resolves but yields nothing', () => {
  beforeAll(async () => {
    await initConfig()
    await Bun.write(
      fs.resolve(API_ROOT, 'api/no-default.ts'),
      'export const helper = 1\n',
    )
    await Bun.write(
      fs.resolve(API_ROOT, 'api/no-return.ts'),
      'export default function handler() {}\n',
    )
    await Bun.write(
      fs.resolve(API_ROOT, 'api/works.ts'),
      "export default () => 'ok'\n",
    )
    __setTestConfig({ root: API_ROOT })
  })

  afterAll(async () => {
    __resetTestConfig()
    ApiHandler.initRoutes()
    await rm(API_ROOT, { recursive: true, force: true })
  })

  test('a file with no default export is a 500 that names the route', async () => {
    const res = (await ApiHandler.handle(
      '/api/no-default',
      new Request('http://localhost/api/no-default'),
    )) as Response

    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(500)

    const body = await res.text()
    expect(body).toContain('no-default.ts')
    expect(body).toContain('export default')
  })

  test('a handler that returns nothing is still a 404', async () => {
    // Distinct from the case above: this module *has* a default export and it
    // ran. `executeModule` yields `undefined` there and `null` above, and the
    // two failures deserve different answers.
    const res = (await ApiHandler.handle(
      '/api/no-return',
      new Request('http://localhost/api/no-return'),
    )) as Response

    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('No response from handler')
  })

  test('a working route is untouched', async () => {
    const res = await ApiHandler.handle(
      '/api/works',
      new Request('http://localhost/api/works'),
    )

    expect(res).toBe('ok')
  })
})

/** The shape `handleRequestError` hands the error registry for a real throw. */
function thrownData() {
  const error = new Error(
    'SQLiteError: no such column: ecr_student_entry.deleted_at',
  )
  return ErrorHandler.extractErrorData(error)
}

describe('ApiErrorHandler', () => {
  test('a 500 body does not carry the stack across the wire', () => {
    const data = thrownData()
    const res = ApiErrorHandler.handle('/api/students', req(), data)

    expect(res.status).toBe(500)
    expect(res.message).not.toContain('at ')
    expect(res.message).not.toContain('api.test')
    expect(res.message).not.toContain('ecr_student_entry')
    expect(res.message).toBe('An unexpected error occurred.')

    // Convention 7: still the one envelope, redacted or not.
    expect(Object.keys(res.toObject()).sort()).toEqual([
      'data',
      'message',
      'status',
      'time',
    ])
  })

  test('development still gets the full stack', () => {
    const data = thrownData()
    const res = asDev(() =>
      ApiErrorHandler.handle('/api/students', req(), data),
    )

    expect(res.message).toBe(data.errorBody)
    expect(res.message).toContain('api.test')
  })

  test('a deliberate 4xx message is unchanged', () => {
    const res = ApiErrorHandler.handle('/api/students', req(), {
      errorCode: 403,
      errorText: 'Forbidden',
      errorBody: 'CSRF origin mismatch',
    })

    expect(res.status).toBe(403)
    expect(res.message).toBe('CSRF origin mismatch')
  })
})
