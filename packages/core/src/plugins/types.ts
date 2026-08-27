import type { Handler } from '../handlers/core/$base'
import type { MixedPromise } from '../types'

export type ValidResponses = Handler.Response

/**
 * A TypeScript project a plugin contributes to the app.
 *
 * Written to `.cache/tsconfig/<name>.json` on every dev boot, as a standalone
 * project invoked directly (`vue-tsc -p .cache/tsconfig/vue.json`). It is
 * deliberately *not* referenced from the app's root `tsconfig.json` — a
 * `references` entry to an unbuilt `noEmit` project makes `tsc -p <app>` fail
 * (TS6305/6306/6310; see `compiler/tsconfig-sync.ts`). Regenerated rather
 * than committed: it is derived from the plugin list and the app's config, and
 * `.cache/` is the disposable half of the two runtime directories.
 */
export interface PluginTsProject {
  /** File name under `.cache/tsconfig/`, and the project's identity. */
  name: string
  /** Usually one of core's three bases. Written through as-is. */
  extends: string
  /** Globs, relative to the **app root** — the generator rewrites them. */
  include?: string[]
  exclude?: string[]
  /**
   * Ambient declarations the plugin owns.
   *
   * Package specifiers are allowed here and resolved to real paths before
   * writing, because TypeScript resolves `files` as paths and would treat
   * `@scope/pkg/x.d.ts` as a missing file rather than a module.
   */
  files?: string[]
  compilerOptions?: Record<string, unknown>
  /**
   * Whether this project should receive `paths` derived from `importMap`.
   *
   * Off by default, and that default is the correction: the generator used to
   * write those `paths` into *every* project on the reasoning that an alias is
   * app-wide. It is not. `importMap` is a **browser** import map — the framework
   * serves it as `<script type="importmap">` and the browser is what resolves
   * its specifiers. An alias in the server project therefore typechecks an
   * import that only the browser can satisfy, which is the same class of bug the
   * server/client split was introduced to end.
   *
   * A plugin whose project compiles browser code should set it.
   */
  importMapPaths?: boolean
  /**
   * Does code in this project run on the server?
   *
   * Declared, not inferred. The first version read `bun-types` out of the base
   * config and treated that as the marker — true today, and an inference about
   * intent drawn from a detail that exists for another reason. A plugin saying
   * what its project *is* cannot drift out of step with itself.
   *
   * What it controls: the app's schema registration, so the ORM's tables are the
   * app's own rather than the permissive `any` fallback. Off for browser code on
   * purpose — `@bakery-framework/orm` is server-only, so a `.ts` bound for the
   * browser importing `DB` should fail to typecheck rather than be helpfully
   * typed, and the package ships TypeScript source calling `Bun.*`, which a
   * client config cannot compile anyway.
   */
  server?: boolean
}

/** What a plugin contributes to the generated tsconfig projects. */
export interface PluginTsConfig {
  /** A project this plugin owns outright — Vue SFCs, for instance. */
  project?: PluginTsProject
}

export interface ServerPlugin {
  name: string
  setup?(config: ProcessedAppConfig): MixedPromise<void>

  /**
   * Declarative, unlike every hook below it: read by the tsconfig generator at
   * dev boot, never by the running server.
   *
   * A plugin that brings its own file type or its own ambient globals needs a
   * project to typecheck them under. `@bakery-framework/plugin-vue` is the
   * worked example — it owns `.vue` and declares `req`/`body` for SFC scope,
   * globals core deliberately does not provide.
   */
  tsconfig?: PluginTsConfig
  onStart?(server: Bun.Server<any>): MixedPromise<void>
  onRequest?(req: Request): ValidResponses
  onRoute?(req: Request): MixedPromise<void>
  onError?(error: Handler.Error.Data, req?: Request): ValidResponses
  onShutdown?(): MixedPromise<void>
  onCompile?(content: string, path: string): MixedPromise<string>
}

export function definePlugin<T extends ServerPlugin>(plugin: T): T {
  return plugin
}
