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

export interface ParsedCacheEntry {
  lastMod: number
  serverScript: string
  cleanContent: string
  scopeId: string
  cssVars: string[]
  hasCss: boolean
}

export interface ServerResponseOptions {
  script: string
  id: string
  lastMod: number
  req: Request
  body: any
}
