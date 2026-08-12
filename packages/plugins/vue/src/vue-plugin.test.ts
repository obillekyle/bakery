import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LRUCache } from '@bakery-framework/core/cache/lru'
import { Bakery } from '@bakery-framework/core/core/bakery'
import { initConfig } from '@bakery-framework/core/core/config'
import { fs, toHash } from '@bakery-framework/core/utils'
import {
  resolveActionTarget,
  validateActionRequest,
  validateActionTarget,
} from './actions'
import { serveVueChunk, vueChunkPath } from './chunks'
import {
  assembleComponent,
  resolveIsCustomElement,
  setVuePluginOptions,
  vueBuildVariant,
} from './compile'
import { VueHandler } from './handler'
import type { VueMeta } from './types'
import {
  compileServerBlock,
  escapeHtml,
  escapeScriptJson,
  extractServerScripts,
  getServerResponse,
  initVueVersion,
  parsedCache,
  parseVueMeta,
  rewriteRelativeImports,
} from './utils'

/** Fixtures live in their own directory so they never pollute the live cache. */
const FIXTURE_DIR = fs.resolve(VueHandler.cacheDir, '__fixtures__')

/** Stable mtime keeps the server-module cache from growing on every test run. */
const FIXED_MOD = 1700000000000

/**
 * resolveActionTarget() resolves against the serve root, so this one fixture
 * cannot live in FIXTURE_DIR. Named distinctively so it cannot collide with a
 * real page in a consuming app.
 */
const ROOT_FIXTURE = '__action-target-test__.vue'
/**
 * Resolved in `beforeAll`, not at module scope: `Bakery.serveRoot` reads the
 * frozen config, which does not exist until `initConfig()` has run. Computing
 * it here meant this file only loaded when some *other* test file happened to
 * have initialised config first — green in a full run, and a crash the moment
 * anyone filtered the suite down to this one file.
 */
let ROOT_FIXTURE_PATH = ''

async function writeFixture(name: string, content: string) {
  const path = fs.resolve(FIXTURE_DIR, name)
  await Bun.write(path, content)
  return { path, file: Bun.file(path), id: toHash(name) }
}

async function getFileText(file: Bun.BunFile): Promise<string> {
  const buf = await file.arrayBuffer()
  const fileName = file.name || ''
  if (fileName.endsWith('.zst')) {
    return new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(buf)))
  }
  if (fileName.endsWith('.gz')) {
    return new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(buf)))
  }
  return new TextDecoder().decode(buf)
}

beforeAll(async () => {
  await initConfig()
  ROOT_FIXTURE_PATH = fs.resolve(Bakery.serveRoot, ROOT_FIXTURE)
  await fs.mkdir(FIXTURE_DIR)
  await Bun.write(ROOT_FIXTURE_PATH, '<template><div>ok</div></template>\n')
})

afterAll(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true })
  await fs.rm(ROOT_FIXTURE_PATH, { force: true })
})

describe('Vue Plugin Server Data Binding & Enhancements', () => {
  test('parsedCache is an instance of LRUCache', () => {
    expect(parsedCache).toBeInstanceOf(LRUCache)
  })

  test('parseVueFile injects __BAKERY_VUE_SERVER_DATA__ token when <script server> is present', async () => {
    const { file, id } = await writeFixture(
      'test-component.vue',
      `
<script server>
export const message = 'Hello Server'
</script>
<template>
  <div>{{ message }}</div>
</template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-component.vue',
      file.lastModified,
    )

    expect(parsed.serverScript.trim()).toBe(
      "export const message = 'Hello Server'",
    )
    expect(parsed.cleanContent).toContain('__BAKERY_VUE_SERVER_DATA__')
    expect(parsed.cleanContent).not.toContain('globalThis.__vue_server')
  })

  test('parseVueFile matches <script lang="ts" server> with attributes before server', async () => {
    const { file, id } = await writeFixture(
      'test-lang-server.vue',
      `
<script lang="ts" server>
export const loggedIn = true
</script>
<template>
  <div>{{ loggedIn }}</div>
</template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-lang-server.vue',
      file.lastModified,
    )

    expect(parsed.serverScript.trim()).toBe('export const loggedIn = true')
    expect(parsed.cleanContent).toContain('__BAKERY_VUE_SERVER_DATA__')
    expect(parsed.cleanContent).not.toContain('export const loggedIn = true')
  })

  test('handleScript for root component resolves the token to globalThis.__vue_server and returns Bun.file', async () => {
    const { file, id } = await writeFixture(
      'test-root.vue',
      `
<script server>
export const title = 'Page Title'
</script>
<template>
  <h1>{{ title }}</h1>
</template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-root.vue',
      file.lastModified,
    )

    const res = await VueHandler.handleScript(id, '/test-root', true, parsed)

    expect(res).toBeDefined()
    expect('name' in (res as any) || 'size' in (res as any)).toBe(true)

    const content = await getFileText(res as Bun.BunFile)
    expect(content).toContain('globalThis.__vue_server')
    expect(content).not.toContain('__BAKERY_VUE_SERVER_DATA__')
  })

  test('handleScript for subcomponent inlines evaluated serverValues and is not cacheable', async () => {
    const { file, id } = await writeFixture(
      'test-sub.vue',
      `
<script server>
export const count = 42
</script>
<template>
  <span>Count: {{ count }}</span>
</template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-sub.vue',
      file.lastModified,
    )

    const res = await VueHandler.handleScript(id, '/test-sub', false, parsed, {
      count: 42,
    })

    expect(res).toBeInstanceOf(Response)
    const response = res as Response
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')

    const content = await response.text()
    expect(content).toContain('{"count":42}')
    expect(content).not.toContain('globalThis.__vue_server')
    expect(content).not.toContain('__BAKERY_VUE_SERVER_DATA__')
  })

  test('handleScript for static subcomponent without <script server> returns Bun.file', async () => {
    const { file, id } = await writeFixture(
      'test-static.vue',
      `
<template>
  <div>Static Component</div>
</template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-static.vue',
      file.lastModified,
    )

    const res = await VueHandler.handleScript(id, '/test-static', false, parsed)

    expect(res).toBeDefined()
    expect('name' in (res as any) || 'size' in (res as any)).toBe(true)

    const content = await getFileText(res as Bun.BunFile)
    expect(content).toContain('Static Component')
  })

  test('getServerResponse handles server script error gracefully', async () => {
    const res = await getServerResponse({
      script: `throw new Error('Database connection failed')`,
      id: 'err-test',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost'),
      body: {},
    })

    expect(res).toEqual({})
  })
})

describe('Vue Meta (<meta /> block)', () => {
  test('parseVueMeta extracts module-only', () => {
    const { meta, clean } = parseVueMeta(
      `<meta module-only />\n<template><div>Hello</div></template>`,
    )
    expect(meta.moduleOnly).toBe(true)
    expect(meta.pageOnly).toBe(false)
    expect(meta.title).toBeNull()
    expect(clean).not.toContain('<meta')
  })

  test('parseVueMeta extracts page-only', () => {
    const { meta, clean } = parseVueMeta(
      `<meta page-only />\n<template><div>Hello</div></template>`,
    )
    expect(meta.pageOnly).toBe(true)
    expect(meta.moduleOnly).toBe(false)
    expect(clean).not.toContain('<meta')
  })

  test('parseVueMeta extracts title', () => {
    const { meta } = parseVueMeta(
      `<meta title="My Page" />\n<template><div>Hello</div></template>`,
    )
    expect(meta.title).toBe('My Page')
    expect(meta.moduleOnly).toBe(false)
  })

  test('parseVueMeta handles combined attributes', () => {
    const { meta } = parseVueMeta(
      `<meta module-only title="Widget" />\n<template><div>Hello</div></template>`,
    )
    expect(meta.moduleOnly).toBe(true)
    expect(meta.title).toBe('Widget')
  })

  test('parseVueMeta defaults when no meta tag', () => {
    const raw = `<template><div>Hello</div></template>`
    const { meta, clean } = parseVueMeta(raw)
    expect(meta.moduleOnly).toBe(false)
    expect(meta.pageOnly).toBe(false)
    expect(meta.title).toBeNull()
    expect(clean).toBe(raw)
  })

  test('parseVueMeta leaves <meta /> inside a template alone', () => {
    const raw = `<template>\n  <meta charset="UTF-8" title="not a directive" />\n</template>`
    const { meta, clean } = parseVueMeta(raw)
    expect(clean).toContain('<meta charset="UTF-8"')
    expect(meta.title).toBeNull()
  })

  test('parseVueMeta does not match hyphenated custom elements', () => {
    const raw = `<meta-box title="Nope" />\n<template><div /></template>`
    const { meta, clean } = parseVueMeta(raw)
    expect(clean).toContain('<meta-box')
    expect(meta.title).toBeNull()
  })

  test('parseVueFile stores meta in parsed cache entry', async () => {
    const { file, id } = await writeFixture(
      'test-meta.vue',
      `<meta module-only title="Test" />\n<template>\n  <div>Module Only</div>\n</template>\n`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-meta.vue',
      file.lastModified,
    )

    expect(parsed.meta.moduleOnly).toBe(true)
    expect(parsed.meta.title).toBe('Test')
    expect(parsed.cleanContent).not.toContain('<meta')
  })

  test('parseVueFile sets default meta when no meta tag', async () => {
    const { file, id } = await writeFixture(
      'test-no-meta.vue',
      `<template>\n  <div>Normal</div>\n</template>\n`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-no-meta.vue',
      file.lastModified,
    )

    expect(parsed.meta.moduleOnly).toBe(false)
    expect(parsed.meta.pageOnly).toBe(false)
    expect(parsed.meta.title).toBeNull()
  })

  test('getServerResponse evaluates export default async function', async () => {
    const res = await getServerResponse({
      script: `
        export default async function(req, body) {
          return { data: 'test-value' }
        }
      `,
      id: 'test-export-default-fn',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
    })

    expect(res).toEqual({ data: 'test-value' })
  })

  test('resolveIsCustomElement handles customElements string array and function', () => {
    setVuePluginOptions({
      customElements: ['iconify-icon', 'my-custom-el'],
      compilerOptions: {},
    })

    expect(resolveIsCustomElement('iconify-icon')).toBe(true)
    expect(resolveIsCustomElement('my-custom-el')).toBe(true)
    expect(resolveIsCustomElement('div')).toBe(false)

    setVuePluginOptions({
      customElements: (tag: string) => tag.startsWith('app-'),
    })

    expect(resolveIsCustomElement('app-header')).toBe(true)
    expect(resolveIsCustomElement('iconify-icon')).toBe(true)
    expect(resolveIsCustomElement('span')).toBe(false)

    setVuePluginOptions({ customElements: [], compilerOptions: {} })
  })
})

describe('Server Actions & Response Overrides', () => {
  test('getServerResponse executes a server action with arguments and global req', async () => {
    const req = new Request('http://localhost/test', {
      headers: { 'user-agent': 'TestAgent/1.0' },
    })
    const res = await getServerResponse({
      script: `
        export const initialData = 'hello'
        export async function addNumbers(a, b) {
          const userAgent = req.headers.get('user-agent')
          return { result: a + b, ua: userAgent }
        }
      `,
      id: 'test-action-add',
      lastMod: FIXED_MOD,
      req,
      body: {},
      actionName: 'addNumbers',
      actionArgs: [10, 20],
    })

    expect(res).toEqual({ result: 30, ua: 'TestAgent/1.0' })
  })

  test('getServerResponse handles Response override', async () => {
    const res = await getServerResponse({
      script: `
        export async function downloadCsv() {
          return new Response('id,name\\n1,Alex', {
            headers: { 'content-type': 'text/csv' },
          })
        }
      `,
      id: 'test-action-csv',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/test'),
      body: {},
      actionName: 'downloadCsv',
      actionArgs: [],
    })

    expect(res).toBeInstanceOf(Response)
    expect(await (res as Response).text()).toBe('id,name\n1,Alex')
  })

  test('parseVueFile generates RPC client stubs for exported functions', async () => {
    const { file, id } = await writeFixture(
      'test-rpc-stub.vue',
      `
<script server>
export const title = 'My Page'
export async function doSomething(val) {
  return val * 2
}
</script>
<template>
  <div>{{ title }}</div>
</template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-rpc-stub.vue',
      file.lastModified,
    )

    expect(parsed.cleanContent).toContain(
      'const { title } = __BAKERY_VUE_SERVER_DATA__;',
    )
    expect(parsed.cleanContent).toContain(
      'const doSomething = async (...args) =>',
    )
    expect(parsed.cleanContent).toContain('__vue_action=doSomething')
  })

  test('action calls skip default export execution', async () => {
    const res = await getServerResponse({
      script: `
        export default async function() {
          return { defaultExecuted: true }
        }
        export async function myAction() {
          return { actionExecuted: true }
        }
      `,
      id: 'test-skip-default',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/test'),
      body: {},
      actionName: 'myAction',
      actionArgs: [],
    })

    expect(res).toEqual({ actionExecuted: true })
    expect((res as any).defaultExecuted).toBeUndefined()
  })

  test('middleware runs on every request and can short-circuit', async () => {
    const script = `
      export async function middleware() {
        if (!req.headers.has('authorization')) {
          return new Response('Unauthorized', { status: 401 })
        }
      }
      export async function secretAction() {
        return { data: 'secret' }
      }
    `

    const unauthRes = await getServerResponse({
      script,
      id: 'test-mw-unauth',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/test'),
      body: {},
      actionName: 'secretAction',
      actionArgs: [],
    })

    expect(unauthRes).toBeInstanceOf(Response)
    expect((unauthRes as Response).status).toBe(401)

    const authRes = await getServerResponse({
      script,
      id: 'test-mw-auth',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/test', {
        headers: { authorization: 'Bearer token' },
      }),
      body: {},
      actionName: 'secretAction',
      actionArgs: [],
    })

    expect(authRes).toEqual({ data: 'secret' })
  })

  test('subcomponent module script supports RPC stubs and actions', async () => {
    const { file, id } = await writeFixture(
      'test-sub-module.vue',
      `
<script server>
export const subData = 'sub-value'
export async function subAction(arg) {
  return { subResult: arg * 10 }
}
</script>
<template>
  <div>{{ subData }}</div>
</template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-sub-module.vue',
      file.lastModified,
    )

    const res = await VueHandler.handleScript(
      id,
      '/test-sub-module.vue',
      false,
      parsed,
      {
        subData: 'sub-value',
      },
    )

    expect(res).toBeInstanceOf(Response)
    const text = await (res as Response).text()
    expect(text).toContain('subAction=async')
    expect(text).toContain('__vue_action=subAction')
  })
})

describe('Action dispatch is restricted to exported functions', () => {
  const script = `
    export const secretValue = 'data'
    export async function allowed() { return { ok: true } }
    export async function middleware() { return undefined }
  `

  test('an exported function is callable', async () => {
    const res = await getServerResponse({
      script,
      id: 'dispatch-allowed',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
      actionName: 'allowed',
      actionArgs: [],
    })
    expect(res).toEqual({ ok: true })
  })

  test('Object.prototype members are not callable as actions', async () => {
    for (const name of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
    ]) {
      const res = await getServerResponse({
        script,
        id: `dispatch-proto-${name}`,
        lastMod: FIXED_MOD,
        req: new Request('http://localhost/'),
        body: {},
        actionName: name,
        actionArgs: [],
      })
      expect((res as any).error).toContain('not found')
    }
  })

  test('middleware is not callable as an action', async () => {
    const res = await getServerResponse({
      script,
      id: 'dispatch-middleware',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
      actionName: 'middleware',
      actionArgs: [],
    })
    expect((res as any).error).toContain('not found')
  })

  test('exported data is not callable as an action', async () => {
    const res = await getServerResponse({
      script,
      id: 'dispatch-data',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
      actionName: 'secretValue',
      actionArgs: [],
    })
    expect((res as any).error).toContain('not found')
  })
})

describe('Server block transpiler forms', () => {
  test('multi-line export default object', async () => {
    const res = await getServerResponse({
      script: `
        export default {
          alpha: 1,
          beta: { nested: true },
        }
      `,
      id: 'default-object',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
    })

    expect(res).toEqual({ alpha: 1, beta: { nested: true } })
  })

  test('non-async export default function', async () => {
    const res = await getServerResponse({
      script: `
        export default function (req, body) {
          return { sync: true }
        }
      `,
      id: 'default-sync-fn',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
    })

    expect(res).toEqual({ sync: true })
  })

  test('export default arrow function', async () => {
    const res = await getServerResponse({
      script: `export default async (req, body) => ({ arrow: true })`,
      id: 'default-arrow',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
    })

    expect(res).toEqual({ arrow: true })
  })

  test('arrow-function exports are treated as actions, not data', async () => {
    const res = await getServerResponse({
      script: `
        export const triple = async (n) => ({ tripled: n * 3 })
      `,
      id: 'arrow-action',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
      actionName: 'triple',
      actionArgs: [4],
    })

    expect(res).toEqual({ tripled: 12 })
  })

  test('arrow-function exports get an RPC stub instead of becoming undefined data', async () => {
    const { file, id } = await writeFixture(
      'test-arrow-stub.vue',
      `
<script server>
export const label = 'hi'
export const doArrow = async (v) => v
</script>
<template><div>{{ label }}</div></template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-arrow-stub.vue',
      file.lastModified,
    )

    expect(parsed.cleanContent).toContain('const doArrow = async (...args) =>')
    expect(parsed.cleanContent).toContain('__vue_action=doArrow')
    expect(parsed.cleanContent).toContain(
      'const { label } = __BAKERY_VUE_SERVER_DATA__;',
    )
  })

  test('generated wrapper does not collide with user identifiers', () => {
    const generated = compileServerBlock(`
      export const finalValue = 'user data'
      export const args = [1, 2]
    `)

    expect(generated).toContain('__bkry_result')
    expect(generated).not.toMatch(/const finalValue: any = \{\}/)
  })

  test('user code may declare its own finalValue without breaking', async () => {
    const res = await getServerResponse({
      script: `
        const finalValue = 'user owned'
        export const echo = finalValue
      `,
      id: 'identifier-collision',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
    })

    expect(res).toEqual({ echo: 'user owned' })
  })
})

describe('Relative import rewriting in server blocks', () => {
  // A describe body runs at collection time, before `beforeAll` — so this has
  // to be resolved per test, after `initConfig()`, for the same reason
  // `ROOT_FIXTURE_PATH` is.
  const filePath = () =>
    fs.resolve(Bakery.serveRoot, 'teacher/pages/students.vue')

  test('rewrites static relative imports to absolute paths', () => {
    const out = rewriteRelativeImports(
      `import { getSections } from '../../api/teacher/sections'`,
      filePath(),
    )
    expect(out).not.toContain("'../../api")
    expect(out).toContain('/api/teacher/sections')
  })

  test('rewrites dynamic import() too', () => {
    // The compiled block runs from the cache dir, so a dynamic import left
    // relative resolves against the cache dir and throws "Cannot find module".
    const out = rewriteRelativeImports(
      `const h = (await import('../../api/teacher/students')).default`,
      filePath(),
    )
    expect(out).not.toContain("import('../../api")
    expect(out).toContain('/api/teacher/students')
  })

  test('leaves bare package specifiers alone', () => {
    const src = `import { ref } from 'vue'\nconst x = await import('node:fs')`
    expect(rewriteRelativeImports(src, filePath())).toBe(src)
  })
})

describe('Multiple <script server> blocks', () => {
  test('extractServerScripts collects every block and removes them all', () => {
    const { script, clean } = extractServerScripts(`
<script server>
export const a = 1
</script>
<script server>
const SECRET = 'db-password'
export const b = 2
</script>
<template><div /></template>
`)

    expect(script).toContain('export const a = 1')
    expect(script).toContain("const SECRET = 'db-password'")
    expect(clean).not.toContain('SECRET')
    expect(clean).not.toContain('export const a')
  })

  test('a </script> inside a string literal does not truncate the block', () => {
    const { script, clean } = extractServerScripts(
      `<script server>
export const marker = "</script><script>window.pwned=1</script>"
const DB_URL = 'postgres://user:pw@host/db'
export async function afterTheString() { return DB_URL }
</script>
<template><div /></template>`,
    )

    // Everything after the string must stay server-side.
    expect(script).toContain('afterTheString')
    expect(script).toContain('postgres://user:pw@host/db')
    expect(clean).not.toContain('afterTheString')
    expect(clean).not.toContain('postgres://')
    expect(clean).not.toContain('window.pwned')
    expect(clean.trim()).toBe('<template><div /></template>')
  })

  test('a </script> inside a comment does not truncate the block', () => {
    const { script, clean } = extractServerScripts(
      `<script server>
// closing tag in a comment: </script>
const SECRET = 'leaked-value'
export const ok = SECRET.length
</script>
<template><div /></template>`,
    )

    expect(script).toContain('leaked-value')
    expect(clean).not.toContain('leaked-value')
    expect(clean.trim()).toBe('<template><div /></template>')
  })

  test('a second server block never reaches the client bundle', async () => {
    const { file, id } = await writeFixture(
      'test-two-server-blocks.vue',
      `
<script server>
export const shown = 'ok'
</script>
<script server>
const DB_PASSWORD = 'super-secret'
export const hidden = DB_PASSWORD.length
</script>
<template><div>{{ shown }}</div></template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-two-server-blocks.vue',
      file.lastModified,
    )

    expect(parsed.cleanContent).not.toContain('DB_PASSWORD')
    expect(parsed.cleanContent).not.toContain('super-secret')
    expect(parsed.serverScript).toContain('super-secret')
  })
})

describe('Script-context escaping', () => {
  test('escapeScriptJson neutralizes a </script> breakout', () => {
    const payload = escapeScriptJson({
      name: '</script><script>alert(1)</script>',
    })
    expect(payload).not.toContain('</script>')
    expect(payload).toContain('\\u003c')
    expect(JSON.parse(payload).name).toBe('</script><script>alert(1)</script>')
  })

  test('escapeScriptJson escapes JS line terminators that JSON allows raw', () => {
    const payload = escapeScriptJson({ text: 'a\u2028b\u2029c' })
    expect(payload).not.toContain('\u2028')
    expect(payload).not.toContain('\u2029')
    expect(JSON.parse(payload).text).toBe('a\u2028b\u2029c')
  })

  test('escapeScriptJson turns undefined into null rather than dropping keys', () => {
    expect(escapeScriptJson({ a: undefined })).toBe('{"a":null}')
  })

  test('escapeHtml escapes markup characters', () => {
    expect(escapeHtml('<b>"x"&\'y\'</b>')).toBe(
      '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;',
    )
  })

  test('handleHtml escapes a breakout payload and the page title', async () => {
    const { file, id } = await writeFixture(
      'test-xss.vue',
      `<meta title="</title><script>alert(1)</script>" />
<script server>
export const studentName = '</script><script>alert(document.cookie)</script>'
</script>
<template><div>{{ studentName }}</div></template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-xss.vue',
      file.lastModified,
    )

    const res = await VueHandler.handleHtml(
      id,
      {},
      '/test-xss',
      { studentName: '</script><script>alert(document.cookie)</script>' },
      parsed,
    )

    const html = await (res as Response).text()
    const start = html.indexOf('globalThis.__vue_server')
    // The payload must not close the tag early: the first `</script>` after the
    // assignment has to be the injected tag's own terminator.
    const payload = html.slice(start, html.indexOf('</script>', start))

    expect(payload).not.toContain('</script>')
    expect(payload).toContain('\\u003c/script>')
    expect(html).not.toContain(
      '<title></title><script>alert(1)</script></title>',
    )
    expect(html).toContain('&lt;/title&gt;')
  })

  test('server data containing $-replacement patterns is preserved verbatim', async () => {
    const { file, id } = await writeFixture(
      'test-dollar.vue',
      `
<script server>
export const note = 'x'
</script>
<template><div>{{ note }}</div></template>
`,
    )

    const parsed = await VueHandler.parseVueFile(
      id,
      file,
      'test-dollar.vue',
      file.lastModified,
    )

    const tricky = "$' and $& and $` and $$"
    const res = await VueHandler.handleHtml(
      id,
      {},
      '/test-dollar',
      { note: tricky },
      parsed,
    )
    const html = await (res as Response).text()

    const start = html.indexOf('globalThis.__vue_server')
    const decl = html.slice(start, html.indexOf('</script>', start))
    const json = JSON.parse(
      decl
        .slice(decl.indexOf('=') + 1)
        .trim()
        .replace(/;$/, ''),
    )

    expect(json.note).toBe(tricky)
  })
})

describe('Server action request validation (CSRF)', () => {
  const url = new URL('http://localhost:3000/admin/pages/students.vue')

  function makeRequest(
    init: RequestInit & { headers?: Record<string, string> },
  ) {
    return new Request(url.href, init)
  }

  test('rejects GET (blocks <img src> style invocation)', () => {
    const res = validateActionRequest(makeRequest({ method: 'GET' }), url)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(405)
  })

  test('rejects a form-encoded POST (blocks cross-origin <form> submits)', () => {
    const res = validateActionRequest(
      makeRequest({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'args=1',
      }),
      url,
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(415)
  })

  test('rejects a cross-origin JSON POST', () => {
    const res = validateActionRequest(
      makeRequest({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://evil.example',
        },
        body: '{}',
      }),
      url,
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  test('rejects a cross-site fetch even without an Origin header', () => {
    const res = validateActionRequest(
      makeRequest({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        body: '{}',
      }),
      url,
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  test('accepts a same-origin JSON POST', () => {
    const res = validateActionRequest(
      makeRequest({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: url.origin,
          'sec-fetch-site': 'same-origin',
        },
        body: '{}',
      }),
      url,
    )
    expect(res).toBeNull()
  })
})

describe('Action dispatch never runs the component it rejects', () => {
  /**
   * A component's top-level server statements are the part that runs no matter
   * what the request asked for. The wrapper used to reach the allow-list only
   * after them, so an action name that does not exist still executed the whole
   * file — and with `__vue_file` naming another component, that was a way to
   * run one page's server block from an unrelated route.
   */
  const PROBE = '__bakery_vue_toplevel_probe__'

  function probeScript() {
    return `
      globalThis['${PROBE}'] = (globalThis['${PROBE}'] || 0) + 1
      export async function allowed() { return { ok: true } }
    `
  }

  test('an unknown action name executes nothing', async () => {
    ;(globalThis as any)[PROBE] = 0

    const res = await getServerResponse({
      script: probeScript(),
      id: 'toplevel-guard',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
      actionName: 'notAnAction',
      actionArgs: [],
    })

    expect((res as any).error).toContain('not found')
    expect((globalThis as any)[PROBE]).toBe(0)
  })

  test('a real action still runs the component', async () => {
    ;(globalThis as any)[PROBE] = 0

    const res = await getServerResponse({
      script: probeScript(),
      id: 'toplevel-guard',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
      actionName: 'allowed',
      actionArgs: [],
    })

    expect(res).toEqual({ ok: true })
    expect((globalThis as any)[PROBE]).toBe(1)
  })

  test('a page render still runs the component', async () => {
    // The guard is scoped to action dispatch: rendering the page it belongs to
    // must be untouched.
    ;(globalThis as any)[PROBE] = 0

    await getServerResponse({
      script: probeScript(),
      id: 'toplevel-guard',
      lastMod: FIXED_MOD,
      req: new Request('http://localhost/'),
      body: {},
    })

    expect((globalThis as any)[PROBE]).toBe(1)
  })
})

describe('Action target gating (__vue_file)', () => {
  const ROUTE_ID = 'route-id'

  function meta(over: Partial<VueMeta> = {}): VueMeta {
    return {
      moduleOnly: false,
      pageOnly: false,
      title: null,
      layout: true,
      ...over,
    }
  }

  const script = `
    export const secret = 'data'
    export async function allowed() { return { ok: true } }
    export async function middleware() { return undefined }
  `

  test('allows an action the target actually exports', () => {
    expect(
      validateActionTarget(
        { id: ROUTE_ID, meta: meta(), serverScript: script },
        ROUTE_ID,
        'allowed',
      ),
    ).toBeNull()
  })

  test('rejects an action the target does not export', () => {
    const res = validateActionTarget(
      { id: 'other-id', meta: meta(), serverScript: script },
      ROUTE_ID,
      'notThere',
    )
    expect(res!.status).toBe(404)
  })

  test('rejects middleware and default as action names', () => {
    for (const name of ['middleware', 'default']) {
      const res = validateActionTarget(
        { id: 'other-id', meta: meta(), serverScript: script },
        ROUTE_ID,
        name,
      )
      expect(res!.status).toBe(404)
    }
  })

  test('rejects exported data as an action name', () => {
    const res = validateActionTarget(
      { id: 'other-id', meta: meta(), serverScript: script },
      ROUTE_ID,
      'secret',
    )
    expect(res!.status).toBe(404)
  })

  test('rejects a target with no server script at all', () => {
    const res = validateActionTarget(
      { id: 'other-id', meta: meta(), serverScript: '' },
      ROUTE_ID,
      'allowed',
    )
    expect(res!.status).toBe(404)
  })

  test('rejects a page-only target driven from another route', () => {
    // The bypass in its clearest form: a public page naming an admin page in
    // `__vue_file`. The route's own gates said nothing about this file.
    const res = validateActionTarget(
      {
        id: 'admin-page-id',
        meta: meta({ pageOnly: true }),
        serverScript: script,
      },
      ROUTE_ID,
      'allowed',
    )
    expect(res!.status).toBe(404)
  })

  test('allows a page-only target on its own route', () => {
    expect(
      validateActionTarget(
        { id: ROUTE_ID, meta: meta({ pageOnly: true }), serverScript: script },
        ROUTE_ID,
        'allowed',
      ),
    ).toBeNull()
  })

  test('allows a module-only target from the page that embeds it', () => {
    // A module exists to be embedded elsewhere, so its stub posts to the host
    // page's route by design. Gating it like a page would break every
    // subcomponent action.
    expect(
      validateActionTarget(
        {
          id: 'module-id',
          meta: meta({ moduleOnly: true }),
          serverScript: script,
        },
        ROUTE_ID,
        'allowed',
      ),
    ).toBeNull()
  })
})

describe('Action target resolution (path traversal)', () => {
  test('rejects traversal outside the serve root', async () => {
    expect(await resolveActionTarget('../.cache/vue/test-root.vue')).toBeNull()
    expect(await resolveActionTarget('../../etc/passwd.vue')).toBeNull()
  })

  test('rejects an absolute path', async () => {
    expect(
      await resolveActionTarget('C:/Windows/system32/config.vue'),
    ).toBeNull()
    expect(await resolveActionTarget('/etc/shadow.vue')).toBeNull()
  })

  test('rejects a non-.vue target', async () => {
    expect(await resolveActionTarget('index.ts')).toBeNull()
    expect(await resolveActionTarget('../../package.json')).toBeNull()
  })

  test('rejects a file that does not exist', async () => {
    expect(await resolveActionTarget('definitely-not-here.vue')).toBeNull()
  })

  test('accepts a real component and derives the page-path cache id', async () => {
    const target = await resolveActionTarget(ROOT_FIXTURE)
    expect(target).not.toBeNull()
    expect(target!.filePath).toBe(ROOT_FIXTURE_PATH)
    expect(target!.id).toBe(toHash(ROOT_FIXTURE))
  })
})

describe('Server module cache lifecycle', () => {
  test('older compiled versions of the same source are pruned', async () => {
    const dir = fs.resolve(VueHandler.cacheDir, 'server')
    const id = 'prune-test'
    const script = `export const value = 1`
    const req = new Request('http://localhost/')

    for (const lastMod of [FIXED_MOD, FIXED_MOD + 1, FIXED_MOD + 2]) {
      await getServerResponse({ script, id, lastMod, req, body: {} })
    }

    const remaining: string[] = []
    for await (const entry of fs.readdir({ folder: dir }, true)) {
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      if (name.startsWith(`${id}_`)) remaining.push(name)
    }

    expect(remaining).toEqual([`${id}_${FIXED_MOD + 2}.ts`])

    await fs.rm(fs.resolve(dir, `${id}_${FIXED_MOD + 2}.ts`), { force: true })
  })
})

/**
 * The build-variant plumbing: which Vue the chunk serves, and what the root
 * component emits, both keyed on the `build` option.
 *
 * The interesting assertions are the *runtime* ones, because runtime is the
 * default and the smaller contract: no `app.config.compilerOptions` assignment
 * — the runtime build has no in-browser compiler to read it, so the line's
 * only observable effect there is Vue warning about itself on every page.
 * Custom elements need nothing at runtime for SFCs: the decision is baked into
 * the render function server-side (`compileTemplateBlock`), which a live
 * runtime-only page verified — configured tag rendered reactively, no
 * "Failed to resolve component".
 */
describe('Vue build variant', () => {
  afterAll(() => {
    setVuePluginOptions({ customElements: [], compilerOptions: {} })
  })

  test('runtime is the default, and the chunk URL carries it', () => {
    setVuePluginOptions({})
    expect(vueBuildVariant()).toBe('runtime')
    expect(vueChunkPath().endsWith('.runtime.js')).toBe(true)

    setVuePluginOptions({ build: 'full' })
    expect(vueBuildVariant()).toBe('full')
    expect(vueChunkPath().endsWith('.full.js')).toBe(true)
  })

  test('the un-varianted URL no longer serves — the cache cannot alias builds', async () => {
    setVuePluginOptions({})
    const version = initVueVersion()
    const res = await serveVueChunk(
      `/_vue/${version}.js`,
      new Request('http://localhost/'),
    )
    expect(res.status).toBe(404)
  })

  test('a root component on the runtime build emits no compilerOptions line', () => {
    setVuePluginOptions({ customElements: ['spice-rack'] })
    const out = assembleComponent({
      scriptCode: 'export default {}',
      renderCode: '',
      isRoot: true,
      scopeId: '',
    })

    expect(out).toContain('createApp')
    expect(out).toContain("mount('#app')")
    expect(out).not.toContain('compilerOptions.isCustomElement')
  })

  test('the full build keeps the runtime custom-element check', () => {
    setVuePluginOptions({ customElements: ['spice-rack'], build: 'full' })
    const out = assembleComponent({
      scriptCode: 'export default {}',
      renderCode: '',
      isRoot: true,
      scopeId: '',
    })

    expect(out).toContain('compilerOptions.isCustomElement')
    expect(out).toContain('spice-rack')
  })

  test('a non-root component never carries the mount block either way', () => {
    setVuePluginOptions({ build: 'full' })
    const out = assembleComponent({
      scriptCode: 'export default {}',
      renderCode: '',
      isRoot: false,
      scopeId: '',
    })

    expect(out).not.toContain('createApp')
    expect(out).not.toContain('compilerOptions')
  })
})

/**
 * The chunk actually serves — the variant tests above only pin the URL shape.
 * Vue resolves from the repo root (workspace hoisting), so this exercises the
 * resolve → build → cache path end to end and pins that the runtime variant
 * really is the runtime build.
 */
describe('serveVueChunk serves the current variant', () => {
  test('the canonical URL answers 200 with the runtime build', async () => {
    setVuePluginOptions({})
    initVueVersion()
    const res = await serveVueChunk(
      vueChunkPath(),
      new Request('http://localhost/'),
    )
    expect(res.status).toBe(200)

    const body = await res.text()
    expect(body.length).toBeGreaterThan(100_000)
    // The runtime build ships no in-browser compiler; compile errors in it
    // reference the loader, not a compiler. `createApp` proves it is Vue.
    expect(body).toContain('createApp')
  })
})
