import { compileText } from '@server/compiler/compiler'
import { Logger } from '@server/logger'
import type { SFCStyleCompileResults } from '@vue/compiler-sfc'

const logger = new Logger('vue')
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
} from './types'

let compiler: typeof import('@vue/compiler-sfc')

async function loadCompiler() {
  if (!compiler) {
    try {
      compiler = await import('@vue/compiler-sfc')
    } catch {
      throw new Error(
        'compiler-sfc not available. Run `bun add vue`.',
      )
    }
  }
  return compiler
}



export async function parseVue(
  options: ParseVueOptions,
): Promise<ParseVueResult> {
  let { content, filename } = options
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
  const { compileScript } = await loadCompiler()
  const result = compileScript(options.descriptor, {
    id: options.id,
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
): Promise<string | null> {
  const { descriptor, id, filename, bindings } = options
  if (!descriptor.template) return null
  const { compileTemplate } = await loadCompiler()
  const result = compileTemplate({
    source: descriptor.template.content,
    filename,
    id,
    scoped: descriptor.styles.some(s => s.scoped),
    compilerOptions: {
      ...(bindings ? { bindingMetadata: bindings } : {}),
      nodeTransforms: [
        (node) => {
          if (node.type === 5 && node.content.type === 4) {
            node.content.content = `_ctx.$fmt(${node.content.content})`
          }
        },
      ],
    },
  })

  if (result.errors?.length) {
    logger.log(`Template compile errors: ${result.errors.join(', ')}`, 'error')
  }

  let code = result.code
  code = code.replace(/^export\s+/m, '')
  code = await compileText(code)
  return code
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
  const { scriptCode, renderCode, isRoot, scopeId } = options
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
    output += `\nimport { createApp } from 'vue';\nconst __app = createApp(${COMPONENT_VAR});\n__app.config.globalProperties.$fmt = (v) => globalThis.$fmt ? globalThis.$fmt(v) : v;\n__app.mount('#app');`
  }

  return output
}

export async function compileVueFile(
  options: CompileVueFileOptions,
): Promise<CompileVueFileResult> {
  const { content, filename, id, isRootScript } = options
  const { descriptor, errors: parseErrors } = await parseVue({
    content,
    filename,
  })
  const hasScoped = descriptor.styles.some(s => s.scoped)
  const { code: scriptCode, bindings } = await compileScriptBlock({
    descriptor,
    id,
  })
  const renderCode = await compileTemplateBlock({
    descriptor,
    id,
    filename,
    bindings,
  })
  const code = assembleComponent({
    scriptCode,
    renderCode,
    isRoot: isRootScript,
    scopeId: hasScoped ? id : undefined,
  })

  const styles = await Promise.all(
    descriptor.styles.map(style => compileStyleBlock({ style, id })),
  )

  return { code, styles, errors: parseErrors }
}
