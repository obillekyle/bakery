import type {
  SFCDescriptor,
  SFCStyleBlock,
  SFCStyleCompileResults,
} from '@vue/compiler-sfc'

export interface ParseVueOptions {
  content: string
  filename: string
}

export interface ParseVueResult {
  descriptor: SFCDescriptor
  errors: string[]
}

export interface CompileScriptOptions {
  descriptor: SFCDescriptor
  id: string
}

export interface CompileScriptResult {
  code: string
  bindings: Record<string, any>
}

export interface CompileTemplateOptions {
  descriptor: SFCDescriptor
  id: string
  filename: string
  bindings?: Record<string, any>
}

export interface CompileStyleOptions {
  style: SFCStyleBlock
  id: string
}

export interface AssembleComponentOptions {
  scriptCode: string
  renderCode: string | null
  isRoot: boolean
  scopeId?: string
}

export interface CompileVueFileOptions {
  content: string
  filename: string
  id: string
  isRootScript: boolean
}

export interface CompileVueFileResult {
  code: string
  styles: SFCStyleCompileResults[]
  errors: string[]
}

export interface VueMeta {
  moduleOnly: boolean
  pageOnly: boolean
  title: string | null
}

export interface ParsedCacheEntry {
  lastMod: number
  serverScript: string
  cleanContent: string
  scopeId: string
  /** Style blocks from the parsed descriptor, reused when building the CSS. */
  styles: SFCStyleBlock[]
  hasCss: boolean
  meta: VueMeta
}

export interface ServerResponseOptions {
  script: string
  id: string
  lastMod: number
  req: Request
  body: any
  filePath?: string
  actionName?: string
  actionArgs?: any[]
}

export type CustomElementsOption = string[] | ((tag: string) => boolean)

export interface VuePluginOptions {
  customElements?: CustomElementsOption
  compilerOptions?: Record<string, any>
  /**
   * Which Vue build the plugin serves at `/_vue/<version>.<build>.js`.
   *
   * `'runtime'` (the default) is ~170KB smaller and is all a Bakery app
   * normally needs: SFC templates are compiled to render functions on the
   * server, and `customElements` is applied there too, so the browser never
   * compiles a template. Opt into `'full'` only for components that hand Vue a
   * raw `template:` string at runtime — those are compiled in the browser and
   * fail on the runtime build with Vue's "runtime compilation is not
   * supported" error.
   */
  build?: 'runtime' | 'full'
}
