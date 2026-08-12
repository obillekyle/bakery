import { compileText } from '@bakery-framework/core/compiler'
import type { SFCStyleCompileResults } from '@vue/compiler-sfc'

import type {
  AssembleComponentOptions,
  CompileScriptOptions,
  CompileScriptResult,
  CompileStyleOptions,
  CompileTemplateOptions,
  CompileVueFileOptions,
  CompileVueFileResult,
  ParseVueOptions,
  ParseVueResult,
  VuePluginOptions,
} from './types'

let compiler: typeof import('@vue/compiler-sfc')

async function loadCompiler() {
  if (!compiler) {
    try {
      compiler = await import('@vue/compiler-sfc')
    } catch {
      throw new Error('compiler-sfc not available. Run `bun add vue`.')
    }
  }
  return compiler
}

let vuePluginOptions: VuePluginOptions = {}

export function setVuePluginOptions(opts?: VuePluginOptions) {
  if (opts) vuePluginOptions = opts
}

/**
 * `'runtime'` unless the app opted into the full build.
 *
 * `customElements` deliberately does *not* force `'full'`: for SFCs the
 * custom-element decision is made server-side, in `compileTemplateBlock`'s
 * `isCustomElement`, and arrives in the browser already baked into the render
 * function. Verified against a live runtime-only page: a configured tag
 * renders as a plain element, reactively, with no "Failed to resolve
 * component" warning. Only browser-compiled `template:` strings need the full
 * build, and only the app knows whether it has any.
 */
export function vueBuildVariant(): 'runtime' | 'full' {
  return vuePluginOptions.build === 'full' ? 'full' : 'runtime'
}

export function resolveIsCustomElement(tag: string): boolean {
  const ce = vuePluginOptions?.customElements
  const userFn = vuePluginOptions?.compilerOptions?.isCustomElement

  if (Array.isArray(ce)) {
    if (ce.includes(tag)) return true
  } else if (typeof ce === 'function') {
    if (ce(tag)) return true
  }

  if (typeof userFn === 'function') {
    if (userFn(tag)) return true
  }

  if (tag === 'iconify-icon') return true

  return false
}

export async function parseVue(
  options: ParseVueOptions,
): Promise<ParseVueResult> {
  const { content, filename } = options
  const { parse } = await loadCompiler()
  const result = parse(content, { filename })
  return {
    descriptor: result.descriptor,
    errors: result.errors.map(e => e.message || String(e)),
  }
}

export async function compileScriptBlock(
  options: CompileScriptOptions,
): Promise<CompileScriptResult> {
  const { descriptor, id } = options

  if (!descriptor.script && !descriptor.scriptSetup) {
    return {
      code: 'export default {}',
      bindings: {},
    }
  }

  if (descriptor.script && descriptor.scriptSetup) {
    const scriptLang = descriptor.script.lang || descriptor.script.attrs?.lang
    if (scriptLang === 'ts') {
      // If the script block is TypeScript, we need to compile it first before passing it to the Vue compiler
      const compiledScript = await compileText(descriptor.script.content)
      descriptor.script.content = compiledScript
    }
  }

  const { compileScript } = await loadCompiler()
  const result = compileScript(descriptor, {
    id,
    isProd: !import.meta.env.DEV,
    hoistStatic: true,
  })
  return {
    code: await compileText(result.content),
    bindings: result.bindings || {},
  }
}

export async function compileTemplateBlock(
  options: CompileTemplateOptions,
): Promise<{ code: string; errors: string[] } | null> {
  const { descriptor, id, filename, bindings } = options
  if (!descriptor.template) return null
  const { compileTemplate } = await loadCompiler()
  const userCompilerOptions = vuePluginOptions.compilerOptions || {}
  const result = compileTemplate({
    source: descriptor.template.content,
    filename,
    id,
    scoped: descriptor.styles.some(s => s.scoped),
    compilerOptions: {
      isCustomElement: resolveIsCustomElement,
      ...userCompilerOptions,
      ...(bindings ? { bindingMetadata: bindings } : {}),
      nodeTransforms: [
        ...((userCompilerOptions.nodeTransforms as any[]) || []),
        (node: any) => {
          if (node.type !== 5) return
          const content = node.content

          // Simple expression: `{{ value }}`.
          //
          // Comments inside an interpolation are not handled specially,
          // deliberately: Vue itself cannot parse `{{ total // pesos }}` —
          // measured against bare `compileTemplate`, which reports the same
          // SyntaxError and emits the raw broken expression. Stripping the
          // comment here just traded that for an unprefixed binding, because
          // Vue's own expression pass had already failed. What Bakery adds
          // instead is failing the compile loudly (see `compileVueFile`)
          // rather than serving a module that cannot parse.
          if (content.type === 4) {
            const rawContent = content.content.trim()
            if (rawContent && !rawContent.startsWith('_ctx.$fmt(')) {
              content.content = `_ctx.$fmt(${rawContent})`
            }
            return
          }

          // Compound expression: `{{ a + b }}`, `{{ cond ? x : y }}`. These are
          // rewritten into child arrays by the built-in transformExpression, so
          // they need wrapping at the children level rather than as a string.
          if (content.type === 8 && !content.__fmtWrapped) {
            content.children = ['_ctx.$fmt(', ...content.children, ')']
            content.__fmtWrapped = true
          }
        },
      ],
    },
  })

  // Reported to the caller, not merely logged: a template Vue cannot compile
  // emits the raw unparseable expression into the render function, so the
  // module *cannot run* — `{{ total // pesos }}` is the measured example, and
  // Vue-alone behaves identically. Serving it anyway was a browser-side
  // SyntaxError with a healthy-looking 200.
  const errors = (result.errors ?? []).map(e =>
    e instanceof Error ? e.message : String(e),
  )

  let code = result.code
  code = code.replace(/^export\s+/m, '')
  code = await compileText(code)
  return { code, errors }
}

export async function compileStyleBlock(
  options: CompileStyleOptions,
): Promise<SFCStyleCompileResults> {
  await loadCompiler()
  return compiler.compileStyle({
    source: options.style.content,
    filename: 'style.css',
    id: options.id,
    scoped: !!options.style.scoped,
    trim: true,
  })
}

export function assembleComponent(options: AssembleComponentOptions): string {
  const { scriptCode, renderCode, isRoot, scopeId, layoutRoute } = options
  const COMPONENT_VAR = '__sfc__'
  let output = scriptCode.replace(
    /\bexport\s+default\s*/,
    `const ${COMPONENT_VAR} = `,
  )

  if (renderCode) {
    const renderFn = renderCode.replace(/^export\s+/m, '')
    output += `\n${renderFn}\n${COMPONENT_VAR}.render = render;`
  }

  if (scopeId) {
    output += `\n${COMPONENT_VAR}.__scopeId = ${JSON.stringify(scopeId)};`
  }

  output += `\nexport default ${COMPONENT_VAR};`

  if (isRoot) {
    if (layoutRoute) {
      // The page renders into the layout's default <slot />. The import is a
      // plain `.vue` specifier so `rewriteVueImports` gives it the same
      // `?__vue_script=module` treatment as any component import — the layout
      // is just a component that happens to be discovered by convention.
      output +=
        `\nimport { createApp, h as __h } from 'vue';` +
        `\nimport __layout from ${JSON.stringify(layoutRoute)};` +
        `\nconst __app = createApp({ render: () => __h(__layout, null, { default: () => __h(${COMPONENT_VAR}) }) });`
    } else {
      output +=
        `\nimport { createApp } from 'vue';` +
        `\nconst __app = createApp(${COMPONENT_VAR});`
    }

    // Full build only. `app.config.compilerOptions` is read exclusively by the
    // in-browser template compiler, which the runtime build does not carry —
    // there, the assignment does nothing except make Vue log a warning about
    // itself on every page, even for apps that configured nothing.
    if (vueBuildVariant() === 'full') {
      output += `\n__app.config.compilerOptions.isCustomElement = ${buildRuntimeCustomElementCheck()};`
    }

    output +=
      `\n__app.config.globalProperties.$fmt = (v) => globalThis.$fmt ? globalThis.$fmt(v) : v;` +
      `\n__app.mount('#app');`
  }

  return output
}

/**
 * Mirror `resolveIsCustomElement` in the browser, so runtime-compiled templates
 * agree with what the SFC compiler did. A predicate that closes over server-side
 * state cannot be serialized — it falls back to the built-in tag.
 */
function buildRuntimeCustomElementCheck(): string {
  const ce = vuePluginOptions.customElements

  if (typeof ce === 'function') {
    return `(tag) => { try { return (${ce.toString()})(tag) || tag === 'iconify-icon' } catch { return tag === 'iconify-icon' } }`
  }

  const tags = [...new Set([...(Array.isArray(ce) ? ce : []), 'iconify-icon'])]
  return `(tag) => ${JSON.stringify(tags)}.includes(tag)`
}

export async function compileVueFile(
  options: CompileVueFileOptions,
): Promise<CompileVueFileResult> {
  const { content, filename, id, isRootScript, layoutRoute } = options
  const { descriptor, errors: parseErrors } = await parseVue({
    content,
    filename,
  })
  const hasScoped = descriptor.styles.some(s => s.scoped)
  const { code: scriptCode, bindings } = await compileScriptBlock({
    descriptor,
    id,
  })
  const template = await compileTemplateBlock({
    descriptor,
    id,
    filename,
    bindings,
  })
  const code = assembleComponent({
    scriptCode,
    renderCode: template?.code ?? null,
    isRoot: isRootScript,
    scopeId: hasScoped ? id : undefined,
    layoutRoute,
  })

  const styles = await Promise.all(
    descriptor.styles.map(style => compileStyleBlock({ style, id })),
  )

  return {
    code,
    styles,
    errors: [...parseErrors, ...(template?.errors ?? [])],
  }
}
