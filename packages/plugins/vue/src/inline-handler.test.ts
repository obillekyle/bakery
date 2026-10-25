import { beforeAll, describe, expect, test } from 'bun:test'
import { initConfig } from '@bakery-framework/core/core/config'
import { fs } from '@bakery-framework/core/utils'
import { compileVueFile } from './compile'
import { VueHandler } from './handler'

/**
 * Template shapes that must either compile or fail *loudly*.
 *
 * Started as a chase for an app report (a multi-line `@click` allegedly
 * emitting a stray `;)`), which never reproduced: every multi-line handler
 * form here compiles, through `compileVueFile` directly and through
 * `parseVueFile`'s `;`-appending preprocessor. What the chase found instead
 * was the mechanism such reports come from: a template Vue cannot compile
 * used to be *logged and served anyway*, broken JS behind a 200. These pin
 * both halves: the shapes that work keep working, and the shapes Vue itself
 * rejects surface as reported errors rather than served modules.
 */
async function compiled(handler: string): Promise<string> {
  const sfc = [
    '<script setup lang="ts">',
    'function saveDraft() {}',
    'function closePanel() {}',
    'const busy = false',
    '</script>',
    '',
    '<template>',
    `  <button :disabled="busy" @click="${handler}">Save</button>`,
    '</template>',
    '',
  ].join('\n')

  const result = await compileVueFile({
    content: sfc,
    filename: 'panel.vue',
    id: `inline-${Bun.hash(handler).toString(36)}`,
    isRootScript: false,
  })

  expect(result.errors).toEqual([])
  return result.code
}

function parses(code: string): { ok: boolean; error?: string } {
  try {
    new Bun.Transpiler({ loader: 'ts' }).transformSync(code)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

describe('multi-line inline template handlers', () => {
  test('a single-line handler compiles and parses', async () => {
    const code = await compiled('saveDraft(); closePanel()')
    expect(parses(code).ok).toBe(true)
  })

  test('the same handler split across lines still parses', async () => {
    const code = await compiled('saveDraft();\n            closePanel()')
    const res = parses(code)
    expect(res.error ?? '').toBe('')
    expect(res.ok).toBe(true)
  })

  test('a trailing newline before the closing quote parses', async () => {
    const code = await compiled('saveDraft();\n')
    const res = parses(code)
    expect(res.error ?? '').toBe('')
    expect(res.ok).toBe(true)
  })

  test('a trailing semicolon after the last statement parses', async () => {
    const code = await compiled('saveDraft();\n            closePanel();')
    const res = parses(code)
    expect(res.error ?? '').toBe('')
    expect(res.ok).toBe(true)
  })

  test('a plain-JS script block takes the same path', async () => {
    const sfc = [
      '<script setup>',
      'function saveDraft() {}',
      'function closePanel() {}',
      '</script>',
      '',
      '<template>',
      '  <button',
      '    @click="saveDraft();',
      '            closePanel()"',
      '  >',
      '    Save',
      '  </button>',
      '</template>',
      '',
    ].join('\n')

    const result = await compileVueFile({
      content: sfc,
      filename: 'panel-js.vue',
      id: 'inline-plainjs',
      isRootScript: false,
    })
    expect(result.errors).toEqual([])
    const res = parses(result.code)
    expect(res.error ?? '').toBe('')
    expect(res.ok).toBe(true)
  })

  test('an interpolation Vue cannot parse is a reported failure, not a served module', async () => {
    // `{{ total // pesos }}` is invalid *upstream*: bare `compileTemplate`
    // reports the same SyntaxError and emits the raw broken expression, so
    // there is nothing to repair here. What Bakery owes the author is the
    // error in `result.errors` (the handler turns that into a 500 naming the
    // file) instead of the old behavior, which logged it server-side and
    // served a module that failed to parse in the browser behind a 200.
    const sfc = [
      '<script setup lang="ts">',
      'const total = 3',
      '</script>',
      '',
      '<template>',
      '  <p>{{ total // pesos }}</p>',
      '</template>',
      '',
    ].join('\n')

    const result = await compileVueFile({
      content: sfc,
      filename: 'total.vue',
      id: 'inline-comment-interp',
      isRootScript: false,
    })

    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.join(' ')).toContain(
      'Error parsing JavaScript expression',
    )
  })

  test('a valid interpolation still compiles with no reported errors', async () => {
    const sfc = [
      '<script setup lang="ts">',
      'const total = 3',
      '</script>',
      '',
      '<template>',
      '  <p>{{ total }}</p>',
      '</template>',
      '',
    ].join('\n')

    const result = await compileVueFile({
      content: sfc,
      filename: 'total-ok.vue',
      id: 'inline-clean-interp',
      isRootScript: false,
    })

    expect(result.errors).toEqual([])
    expect(result.code).toMatch(/\$fmt\(\$setup\.total\)/)
    expect(parses(result.code).ok).toBe(true)
  })
})

/**
 * `parseVueFile` runs a regex over multi-line event attributes *before* the
 * SFC compiler sees them, appending `;` when the value has none: my first
 * repro pass missed this layer entirely by calling `compileVueFile` directly.
 * These push the preprocessed output through the full compile.
 */
describe('the multi-line handler preprocessor', () => {
  // parseVueFile reaches Bakery.serveRoot through layout discovery.
  beforeAll(() => initConfig())

  async function throughParse(handler: string): Promise<string> {
    const sfc = [
      '<script setup lang="ts">',
      'function saveDraft() {}',
      'function closePanel() {}',
      '</script>',
      '',
      '<template>',
      `  <button @click="${handler}">Save</button>`,
      '</template>',
      '',
    ].join('\n')

    const id = `pre-${Bun.hash(handler).toString(36)}`
    const dir = fs.resolve(VueHandler.cacheDir, '__fixtures__', 'inline')
    const file = `${dir}/${id}.vue`
    await Bun.write(file, sfc)

    const parsed = await VueHandler.parseVueFile(
      id,
      Bun.file(file),
      file,
      1700000000000,
    )
    const result = await compileVueFile({
      content: parsed.cleanContent,
      filename: `${id}.vue`,
      id,
      isRootScript: false,
    })
    expect(result.errors).toEqual([])
    return result.code
  }

  test('multi-line without any semicolon (the ; gets appended)', async () => {
    const code = await throughParse('saveDraft()\n            closePanel()')
    const res = parses(code)
    expect(res.error ?? '').toBe('')
    expect(res.ok).toBe(true)
    // Compiled as two statements in a block, which is what the `;` is for.
    expect(code).toMatch(
      /\$event\)?\s*=>\s*\{\s*\$setup\.saveDraft\(\);?\s*\$setup\.closePanel\(\)\s*\}/,
    )
  })

  // The shapes a formatter breaks across lines that are already one
  // expression. Each used to get a `;` appended: the arrows compiled to
  // `(d) => {…};` inside the render function's props and the module did not
  // parse, the `function` failed Vue's own compile, and the member path
  // compiled to `$event => { $setup.saveDraft }`, which never calls it.
  test('an arrow handler broken across lines is the handler itself', async () => {
    const code = await throughParse(
      '\n    (d) => {\n      saveDraft()\n      closePanel()\n    }\n  ',
    )
    expect(parses(code).error ?? '').toBe('')
    expect(code).toMatch(
      /\(d\)\s*=>\s*\{\s*\$setup\.saveDraft\(\);?\s*\$setup\.closePanel\(\)/,
    )
  })

  test('an arrow handler with a TypeScript cast, broken across lines', async () => {
    const code = await throughParse(
      "\n    (e) => (e as Event).type === 'click' && saveDraft()\n  ",
    )
    expect(parses(code).error ?? '').toBe('')
    expect(code).toMatch(
      /\(e\)\s*=>\s*e\.type\s*===\s*"click"\s*&&\s*\$setup\.saveDraft\(\)/,
    )
  })

  test('a function expression broken across lines', async () => {
    const code = await throughParse(
      '\n    function (e) {\n      saveDraft()\n    }\n  ',
    )
    expect(parses(code).error ?? '').toBe('')
    expect(code).toMatch(/function\s*\(e\)\s*\{\s*\$setup\.saveDraft\(\)/)
  })

  test('a member path on lines of its own still calls the function', async () => {
    const code = await throughParse('\n    saveDraft\n  ')
    expect(parses(code).error ?? '').toBe('')
    expect(code).toMatch(/\$setup\.saveDraft\(\.\.\.args\)/)
  })

  test('multi-line ending in a trailing newline', async () => {
    const code = await throughParse('saveDraft()\n')
    const res = parses(code)
    expect(res.error ?? '').toBe('')
    expect(res.ok).toBe(true)
  })

  test('multi-line with a trailing line comment', async () => {
    const code = await throughParse(
      'saveDraft() // then close\n            closePanel()',
    )
    const res = parses(code)
    expect(res.error ?? '').toBe('')
    expect(res.ok).toBe(true)
  })

  test('multi-line already carrying semicolons is untouched and compiles', async () => {
    const code = await throughParse('saveDraft();\n            closePanel();')
    const res = parses(code)
    expect(res.error ?? '').toBe('')
    expect(res.ok).toBe(true)
  })
})
