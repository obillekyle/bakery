import { describe, expect, test } from 'bun:test'
import { fs } from '@bakery-framework/core/utils'
import {
  collectExportedFunctionNames,
  compileServerBlock,
  extractImportsAndBody,
  extractServerScripts,
  parseVueMeta,
  rewriteRelativeImports,
  rewriteVueImports,
} from './utils'

/**
 * Unit coverage for the pure helpers in `utils.ts`.
 *
 * Everything here is a string in, string out — no config, no fixtures, no
 * filesystem, so there is nothing to set up or tear down and no shared state
 * to leak into another file. `vue-plugin.test.ts` exercises the same code
 * through `getServerResponse` and a real SFC parse, which is the right level
 * for the wiring but tells you only that *something* in the chain broke; these
 * name the function.
 *
 * Paths are built with `fs.resolve` rather than written as literals: a bare
 * `/srv/x` picks up a drive letter on Windows and `C:/x` is treated as
 * relative everywhere else, so a literal expectation is green on exactly one
 * platform.
 */

const PAGE_DIR = fs.resolve(process.cwd(), '__vue-utils-test__/pages/teacher')
const PAGE = `${PAGE_DIR}/students.vue`
const abs = (rel: string) => fs.resolve(PAGE_DIR, rel)

const transpiler = new Bun.Transpiler({ loader: 'ts' })

/** Syntax-check emitted wrapper code the way the runtime import would. */
function parseError(code: string): string | null {
  try {
    transpiler.transformSync(code)
    return null
  } catch (error) {
    return String(error)
  }
}

/** The static `__bkry_actions` allow-list baked into a compiled wrapper. */
function actionList(compiled: string): string[] {
  const match = compiled.match(/__bkry_actions = new Set\((\[.*?\])\)/)
  if (!match) throw new Error('no action allow-list in compiled output')
  return JSON.parse(match[1])
}

describe('rewriteRelativeImports', () => {
  test('returns the code untouched when there is no file path', () => {
    const src = `import { db } from './db'`
    expect(rewriteRelativeImports(src)).toBe(src)
  })

  test('a sibling ./ import resolves against the SFC directory', () => {
    expect(rewriteRelativeImports(`import { db } from './db'`, PAGE)).toBe(
      `import { db } from '${abs('db')}'`,
    )
  })

  test('nested ../../ depth walks up from the SFC, not the cache dir', () => {
    const out = rewriteRelativeImports(
      `import { getSections } from '../../api/teacher/sections'`,
      PAGE,
    )
    expect(out).toBe(
      `import { getSections } from '${abs('../../api/teacher/sections')}'`,
    )
    expect(out).not.toContain('..')
  })

  test('bare, scoped and root-absolute specifiers are left alone', () => {
    const src = [
      `import { ref } from 'vue'`,
      `import { z } from '@scope/pkg'`,
      `import { readFile } from 'node:fs/promises'`,
      `import config from '/already/absolute'`,
    ].join('\n')
    expect(rewriteRelativeImports(src, PAGE)).toBe(src)
  })

  test('a relative-looking string that is not an import is left alone', () => {
    const src = `const label = './db'\nconst rows = await fetchJson('./api/rows')`
    expect(rewriteRelativeImports(src, PAGE)).toBe(src)
  })

  test('a query suffix rides along on the absolute path', () => {
    // Bun keeps `?raw`-style suffixes on the specifier, so the rewrite has to
    // leave them attached rather than resolving them away.
    expect(
      rewriteRelativeImports(`const r = await import('./notes.txt?raw')`, PAGE),
    ).toBe(`const r = await import('${abs('notes.txt')}?raw')`)
  })

  test('side-effect imports and re-exports are rewritten too', () => {
    expect(
      rewriteRelativeImports(
        `import './setup'\nexport { helper } from './helpers'`,
        PAGE,
      ),
    ).toBe(
      `import '${abs('setup')}'\nexport { helper } from '${abs('helpers')}'`,
    )
  })

  test('a double-quoted specifier is rewritten and normalised to single quotes', () => {
    expect(rewriteRelativeImports(`import db from "./db"`, PAGE)).toBe(
      `import db from '${abs('db')}'`,
    )
  })

  test('a specifier on the line after `from` is still found', () => {
    expect(rewriteRelativeImports(`import db from\n  './db'`, PAGE)).toBe(
      `import db from\n  '${abs('db')}'`,
    )
  })
})

describe('extractImportsAndBody', () => {
  test('hoists the leading imports and returns the rest as the body', () => {
    const { imports, body } = extractImportsAndBody(
      `import { db } from 'x'\nimport './side-effect'\nexport const a = 1\n`,
    )
    expect(imports).toBe(`import { db } from 'x'\nimport './side-effect'`)
    expect(body.trim()).toBe('export const a = 1')
  })

  test('comments and blank lines ahead of an import do not stop the scan', () => {
    const { imports } = extractImportsAndBody(
      `// lead\n\n/* block */\nimport a from 'x'\n\nconst z = 1`,
    )
    expect(imports).toBe(`import a from 'x'`)
  })

  test('a named import spread over several lines is taken whole', () => {
    const { imports, body } = extractImportsAndBody(
      `import {\n  one,\n  two,\n} from 'x'\nconst z = 1`,
    )
    expect(imports).toBe(`import {\n  one,\n  two,\n} from 'x'`)
    expect(body.trim()).toBe('const z = 1')
  })

  test('the scan stops at the first statement, so a later import stays in the body', () => {
    const { imports, body } = extractImportsAndBody(
      `const z = 1\nimport late from 'x'`,
    )
    expect(imports).toBe('')
    expect(body).toContain(`import late from 'x'`)
  })
})

describe('collectExportedFunctionNames', () => {
  test('collects function declarations, async and plain', () => {
    expect(
      collectExportedFunctionNames(
        `export function save() {}\nexport async function load() {}`,
      ),
    ).toEqual(['save', 'load'])
  })

  test('collects callable consts in every spelling', () => {
    expect(
      collectExportedFunctionNames(
        [
          `export const paren = (a, b) => a + b`,
          `export const bare = v => v`,
          `export const asyncArrow = async () => 1`,
          `export let expr = function () {}`,
        ].join('\n'),
      ),
    ).toEqual(['paren', 'bare', 'asyncArrow', 'expr'])
  })

  test('ignores data exports — they are page data, not actions', () => {
    expect(
      collectExportedFunctionNames(
        `export const total = 5\nexport const list = [1, 2]\nexport const cfg = { a: 1 }`,
      ),
    ).toEqual([])
  })

  test('deduplicates a name that both regexes reach', () => {
    expect(
      collectExportedFunctionNames(
        `export function save() {}\nexport function save() {}`,
      ),
    ).toEqual(['save'])
  })
})

describe('compileServerBlock', () => {
  /**
   * Shapes whose wrapper must be syntactically valid. An invalid one is not a
   * compile error anywhere — the module fails to import at request time and
   * `getServerResponse` logs and serves `{}`, so the page renders with no data
   * and no obvious cause.
   */
  const SHAPES: Record<string, string> = {
    'a data export': `export const total = 5`,
    'a function action': `export async function save(v) { return v }`,
    'an arrow action': `export const save = async v => v`,
    'a multi-line object default': `export default {\n  a: 1,\n  b: 2,\n}`,
    'an arrow default with a block body': `export default async req => {\n  const a = 1\n  return { a }\n}`,
    'a named function default': `export default function named() { return { n: 1 } }`,
    'a default followed by more exports': `export default { a: 1 }\nexport const b = 2`,
    'a destructured export': `export const { a, b } = getPair()`,
    'an aliased brace export': `const x = 1\nexport { x as y }`,
    'a semicolon inside a string': `export const s = 'a;b'\nexport const t = 2`,
    'a top-level await': `const d = await Promise.resolve(1)\nexport const v = d`,
    'exported types': `export type T = { a: number };\nexport interface I { b: string }\nexport const c = 1`,
  }

  for (const [name, src] of Object.entries(SHAPES)) {
    test(`emits parseable TypeScript for ${name}`, () => {
      expect(parseError(compileServerBlock(src))).toBeNull()
    })
  }

  test('imports are hoisted above the wrapper and made absolute', () => {
    const out = compileServerBlock(
      `import { db } from './db'\nexport const rows = db.all()`,
      PAGE,
    )
    const wrapper = out.indexOf('function __bkry_server')

    expect(out).toContain(`import { db } from '${abs('db')}'`)
    expect(out.indexOf('import { db }')).toBeLessThan(wrapper)
    expect(out.slice(wrapper)).not.toContain('import { db }')
  })

  test('exported types and interfaces are stripped', () => {
    const out = compileServerBlock(
      `export type Row = { id: number };\nexport interface Cfg { on: boolean }\nexport const a = 1`,
    )
    expect(out).not.toContain('export type')
    expect(out).not.toContain('export interface')
    expect(out).not.toContain('Row')
  })

  test('the action allow-list is the exported callables minus middleware', () => {
    const out = compileServerBlock(
      [
        `export async function middleware() {}`,
        `export async function save() {}`,
        `export const load = async () => 1`,
        `export const total = 5`,
      ].join('\n'),
    )
    expect(actionList(out)).toEqual(['save', 'load'])
  })

  test('a data export stays a local binding and also lands on the result', () => {
    const out = compileServerBlock(
      `export const total = 5\nconst doubled = total * 2`,
    )
    expect(out).toContain(`const total = __bkry_result['total'] = 5`)
  })

  test('a destructured export copies every key onto the result', () => {
    const out = compileServerBlock(`export const { alpha, beta } = getPair()`)
    expect(out).toContain(`__bkry_result['alpha'] = alpha;`)
    expect(out).toContain(`__bkry_result['beta'] = beta;`)
  })

  test('a brace export uses the alias, not the local name', () => {
    const out = compileServerBlock(`const x = 1\nexport { x as y }`)
    expect(out).toContain('Object.assign(__bkry_result, { y: x })')
  })

  test('the default export becomes a deferred const, not an inline return', () => {
    const out = compileServerBlock(`export default { a: 1 }`)
    expect(out).toContain('__bkry_defaultVal = { a: 1 }')
    expect(out).not.toContain('export default {')
  })

  test('no default export means no default machinery', () => {
    expect(compileServerBlock(`export const a = 1`)).not.toContain(
      '__bkry_defaultVal',
    )
  })

  test('a multi-line default expression survives, and so does the code after it', () => {
    // The expression scanner is what makes this work: stopping at the first
    // newline would cut the object at `{` and spill `a: 1,` into the body.
    const out = compileServerBlock(
      `export default {\n  a: 1,\n  b: 2,\n}\nexport const tail = 3`,
    )
    expect(out).toContain('b: 2')
    expect(out).toContain(`const tail = __bkry_result['tail'] = 3`)
    expect(parseError(out)).toBeNull()
  })
})

describe('rewriteVueImports', () => {
  test('marks .vue specifiers as module requests, keeping the quote style', () => {
    expect(
      rewriteVueImports(
        `import A from './A.vue'\nconst B = () => import("./B.vue")`,
      ),
    ).toBe(
      `import A from './A.vue?__vue_script=module'\nconst B = () => import("./B.vue?__vue_script=module")`,
    )
  })

  test('leaves non-.vue imports alone', () => {
    const src = `import C from './C.js'\nimport { ref } from 'vue'`
    expect(rewriteVueImports(src)).toBe(src)
  })
})

describe('extractServerScripts', () => {
  test('a file with no server block is returned unchanged', () => {
    const raw = `<script setup>const a = 1</script>\n<template><div /></template>`
    expect(extractServerScripts(raw)).toEqual({ script: '', clean: raw })
  })

  test('<script serverless> is not a server block', () => {
    // The attribute match is anchored on a following delimiter precisely so a
    // longer attribute starting with "server" cannot claim the block — and a
    // false positive here deletes a client script and runs it on the server.
    const raw = `<script serverless>const a = 1</script>`
    expect(extractServerScripts(raw)).toEqual({ script: '', clean: raw })
  })
})

describe('parseVueMeta', () => {
  test('a quoted attribute value containing > does not truncate the tag', () => {
    const { meta, clean } = parseVueMeta(`<meta title="a > b" />\n<template/>`)
    expect(meta.title).toBe('a > b')
    expect(clean.trim()).toBe('<template/>')
  })

  test('directives accumulate across several meta tags', () => {
    const { meta } = parseVueMeta(
      `<meta no-layout />\n<meta page-only />\n<meta title="Reports" />\nrest`,
    )
    expect(meta).toEqual({
      moduleOnly: false,
      pageOnly: true,
      title: 'Reports',
      layout: false,
    })
  })
})
