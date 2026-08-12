import { describe, expect, test } from 'bun:test'
import { compileVueFile } from './compile'

/**
 * A multi-line inline handler must survive compilation.
 *
 * `@click="saveDraft();\n  closePanel()"` is what any formatter produces once
 * the attribute passes the line width. Reported from an app: the compiled
 * module failed to parse with a stray `;)`, so reformatting a template broke
 * the build.
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

  test('an interpolation with a trailing line comment parses', async () => {
    // The $fmt wrap is string surgery — `_ctx.$fmt(<raw>)` — so a `//` at the
    // end of the raw expression can swallow the closing paren.
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
    const res = parses(result.code)
    expect(res.error ?? '').toBe('')
    expect(res.ok).toBe(true)
  })
})
