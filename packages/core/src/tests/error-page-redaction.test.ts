import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { __resetTestConfig, __setTestConfig, initConfig } from '../core/config'
import { TSXErrorHandler } from '../handlers/assets/tsx'
import { HTMLErrorHandler } from '../handlers/routes/html'
import { fs } from '../utils'
import { asDev, asProd } from './fixtures'

/**
 * `ErrorHandler.publicBody` redacts `errorBody` — the thrown error's stack —
 * outside DEV, and `DefaultErrorHandler`/`ApiErrorHandler` both render through
 * it. The HTML and TSX error pages did not: they merged the raw error data
 * into the page params, which reach the document twice — through `{{...}}`
 * substitution and through the `window.__PAGE_PARAMS__` script that
 * `DOMTools.params` injects into *every* page.
 *
 * That second path is why this is not an app-template problem: an `error.html`
 * that never mentions `errorBody` still published the stack. Verified against
 * a live production server before the fix — absolute source paths and all.
 */

const ROOT = fs.resolve(process.cwd(), '.cache/__err-redact__')
const STACK = 'SECRETSTACK at C:/private/path/secret.ts:9:9'
const ERROR = {
  errorCode: 500,
  errorText: 'Something broke',
  errorBody: STACK,
}

const req = () => new Request('http://localhost/__boom')

async function bodyOf(res: any): Promise<string> {
  if (!res) return ''
  if (typeof res === 'string') return res
  if (res instanceof Response) return await res.text()
  if (res instanceof Blob) return await res.text()
  return String(res)
}

beforeAll(async () => {
  await initConfig()
  // A template that *does* interpolate the body, and one that never mentions
  // it — the leak has to be closed for both.
  await Bun.write(
    `${ROOT}/error.html`,
    '<html><body><pre>{{errorBody}}</pre></body></html>\n',
  )
  await Bun.write(
    `${ROOT}/quiet/error.html`,
    '<html><body><h1>Sorry</h1></body></html>\n',
  )
  __setTestConfig({ root: ROOT } as any)
})

afterAll(async () => {
  __resetTestConfig()
  await rm(ROOT, { recursive: true, force: true })
})

describe('HTML error pages redact the stack outside DEV', () => {
  test('production does not publish the stack through {{errorBody}}', async () => {
    const text = await asProd(() =>
      HTMLErrorHandler.handle('/__boom', req(), ERROR).then(bodyOf),
    )
    expect(text).not.toContain('SECRETSTACK')
    expect(text).not.toContain('C:/private/path')
  })

  test('production does not publish it through __PAGE_PARAMS__ either', async () => {
    // The framework injects the whole params object into every page, so a
    // template that never references the body still leaked it.
    __setTestConfig({ root: fs.resolve(ROOT, 'quiet') } as any)
    const text = await asProd(() =>
      HTMLErrorHandler.handle('/__boom', req(), ERROR).then(bodyOf),
    )
    __setTestConfig({ root: ROOT } as any)
    expect(text).not.toContain('SECRETSTACK')
  })

  test('DEV still shows it — that is the whole point of the mode', async () => {
    const text = await asDev(() =>
      HTMLErrorHandler.handle('/__boom', req(), ERROR).then(bodyOf),
    )
    expect(text).toContain('SECRETSTACK')
  })

  test('the error text itself is still shown, as everywhere else', async () => {
    // `publicBody` redacts the stack, not the message: `DefaultErrorHandler`
    // renders `errorText` in its heading in every mode.
    const text = await asProd(() =>
      HTMLErrorHandler.handle('/__boom', req(), ERROR).then(bodyOf),
    )
    expect(text).toContain('Something broke')
  })
})

describe('TSX error pages redact the stack outside DEV', () => {
  beforeAll(async () => {
    await Bun.write(
      `${ROOT}/error.tsx`,
      'export default (_req: any, body: any) => `<html><body>${body.errorBody}</body></html>`\n',
    )
  })

  test('production does not publish the stack', async () => {
    const text = await asProd(() =>
      TSXErrorHandler.handle('/__boom', req(), ERROR).then(bodyOf),
    )
    expect(text).not.toContain('SECRETSTACK')
  })
})

describe('ordinary pages still render', () => {
  /**
   * Regression guard. The first version of the redaction called
   * `publicErrorData(errorData)` unconditionally, but `errorData` is
   * `undefined` on a normal page render — `DEFAULT_ERROR` exists only on the
   * error handler — so every dynamic page died with "undefined is not an
   * object (evaluating 'error.errorCode')", which then became the rendered
   * error. The unit tests above all passed: they only ever exercised the
   * error path. A live production request is what caught it.
   */
  beforeAll(async () => {
    // Deliberately dynamic: a static page takes the pre-assembled cache branch
    // and never reaches the params merge (and comes back compressed, which is
    // how the first version of this test fooled itself). A `[id]` page is the
    // path that actually crashed.
    await Bun.write(
      `${ROOT}/plain/[id].html`,
      '<html><body><p>PLAIN-OK {{id}}</p></body></html>\n',
    )
  })

  test('a dynamic page with no error data renders', async () => {
    const { HTMLHandler } = await import('../handlers/routes/html')
    const text = await asProd(() =>
      HTMLHandler.handle(
        '/plain/42',
        new Request('http://localhost/plain/42'),
      ).then(bodyOf),
    )
    expect(text).toContain('PLAIN-OK')
    expect(text).toContain('42')
  })
})
