import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleComponent, compileTemplateBlock, parseVue } from './compile'

/** The assembled module, run the way a browser would import it. */
async function runAssembled(scriptCode: string, renderCode: string) {
  const out = assembleComponent({ scriptCode, renderCode, isRoot: false })
  const file = join(tmpdir(), `bakery-sfc-${Bun.randomUUIDv7()}.mjs`)
  await Bun.write(file, out)
  try {
    return (await import(file)).default
  } finally {
    await rm(file, { force: true })
  }
}

describe('assembleComponent - the component variable', () => {
  test('a script with no default export still runs', async () => {
    // Measured before the fix: `ReferenceError: __sfc__ is not defined`, on a
    // page that answered 200 and rendered blank.
    const component = await runAssembled(
      `const note = 'plain'`,
      'function render() { return note }',
    )
    expect(component.render()).toBe('plain')
  })

  test('a default export is still the component', async () => {
    const component = await runAssembled(
      `export default { name: 'kept' }`,
      'function render() { return null }',
    )
    expect(component.name).toBe('kept')
  })
})

describe('compileTemplateBlock - built-in elements', () => {
  test('selectedcontent is an element, not a component to resolve', async () => {
    const code = await renderCodeFor(
      '<template><selectedcontent></selectedcontent></template>',
    )
    expect(code).toContain('"selectedcontent"')
    expect(code).not.toContain('resolveComponent')
  })
})

/**
 * The compiled render function must not carry an `export` into the assembled
 * module, and the *only* thing making that true is an ordering nothing else
 * enforces.
 *
 * `compileTemplateBlock` strips with `/^export\s+/m` and then calls
 * `compileText`, which minifies. The anchor works on the compiler's multi-line
 * output, where `export function render` starts a line. It does not work
 * afterwards: minified output is one line beginning `import{…}from"vue";`, and
 * `^` can only match position 0. Measured over four render shapes, the strip
 * is correct on all four before minification and wrong on the one real shape
 * after.
 *
 * So swapping those two statements is a silent break. The bundle still builds,
 * the route still answers 200, and the browser gets a classic-script module
 * with a stray `export` in the middle. This file is what turns that into a red
 * test instead.
 *
 * It also pins the removal of a second strip in `assembleComponent`, which ran
 * the same anchored pattern over the already-minified, already-stripped result
 * and therefore could never have fired on real input.
 */
async function renderCodeFor(template: string): Promise<string> {
  const { descriptor } = await parseVue({
    content: template,
    filename: 'probe.vue',
  })
  const result = await compileTemplateBlock({
    descriptor,
    id: 'probe',
    filename: 'probe.vue',
  })
  if (!result) throw new Error('no template block')
  return result.code
}

describe('the compiled render function carries no export', () => {
  // Four shapes, because what the compiler emits before the render function
  // varies with the template: an import prologue always, hoisted statics
  // sometimes, a scope id sometimes. Each one changes where `export` sits.
  const templates: Record<string, string> = {
    interpolation: '<template><div>{{ msg }}</div></template>',
    hoisted:
      '<template><div><span class="a">static</span><b>{{ x }}</b></div></template>',
    loop: '<template><ul><li v-for="i in items" :key="i">{{ i }}</li></ul></template>',
    scoped:
      '<template><p>{{ a }}</p></template><style scoped>p{color:red}</style>',
  }

  for (const [name, template] of Object.entries(templates)) {
    test(`${name}: compileTemplateBlock strips it before minifying`, async () => {
      const code = await renderCodeFor(template)

      expect(code).toContain('function render')
      expect(code).not.toMatch(/\bexport\s+function\s+render/)

      // The evidence that the strip ran *before* `compileText` rather than
      // merely that it ran: the output is one line, which is the state the
      // anchored pattern cannot handle. If this ever reports more than one
      // line the ordering has changed and the assertion above is passing for
      // a different reason than the one documented.
      expect(code.split('\n').length).toBe(1)
    })
  }

  test('assembleComponent does not re-strip, and does not need to', async () => {
    const renderCode = await renderCodeFor(
      '<template><div>{{ msg }}</div></template>',
    )
    const out = assembleComponent({
      scriptCode: 'export default {}',
      renderCode,
      isRoot: false,
    })

    // One export in the assembled module, the component's own, added last.
    expect(out).not.toMatch(/\bexport\s+function\s+render/)
    expect(out).toContain('__sfc__.render = render;')
    expect(out.match(/\bexport\s+/g)?.length).toBe(1)
  })

  test('the anchored pattern is why the order matters, stated as a fact', () => {
    // Not a test of the plugin: a test of the claim in the comment, so that
    // the claim cannot quietly stop being true as bundlers change. This is
    // the exact shape `compileText` produces.
    const minified =
      'import{toDisplayString as _t}from"vue";export function render(_ctx){return null}'
    const multiline =
      'import{toDisplayString as _t}from"vue"\n\nexport function render(_ctx){return null}'

    expect(multiline.replace(/^export\s+/m, '')).not.toMatch(
      /\bexport\s+function\s+render/,
    )
    // The one that matters: on minified input the strip is a no-op.
    expect(minified.replace(/^export\s+/m, '')).toMatch(
      /\bexport\s+function\s+render/,
    )
  })
})
