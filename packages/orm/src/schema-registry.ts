/**
 * Type-level extension point connecting the framework to the app's schema.
 *
 * The dependency must point one way: the app depends on the framework, never
 * the reverse. Yet the ORM's types are derived from the app's `schema.ts` —
 * previously via a direct `import ... from '~/schema'`, which meant the
 * framework's own types imported an app-owned, gitignored file, and a fresh
 * clone could not typecheck its database layer.
 *
 * Instead, the app *registers* its schema here through declaration merging
 * (the same pattern TanStack Router and vue-router use). At the bottom of
 * `schema.ts`:
 *
 * ```ts
 * declare module '@bakery/orm/schema-registry' {
 *   interface SchemaRegistry {
 *     schema: {
 *       DBSchema: MyDBSchema
 *       DBOptionals: MyDBOptionals
 *       Views: DBInfo.Views
 *     }
 *   }
 * }
 * ```
 *
 * With no registration, every table and column falls back to permissive
 * `any`-shaped records — the ORM stays fully usable, just untyped. The
 * runtime needs no registration at all: schema *values* are loaded by path
 * (see `sync/load.ts`), from `schema` in `server.config.ts` when the app sets
 * one and otherwise from `<cwd>/orm/index.ts` or `<cwd>/schema.ts`, whichever
 * exists. Absence is tolerated; only a *configured* path that does not exist
 * is an error.
 */

import type { MapOf } from '@bakery/core/types'

// Augmented by the app; empty until then.
export interface SchemaRegistry {}

type Registered = SchemaRegistry extends { schema: infer S } ? S : never

/** Table map: `{ tableName: { column: type } }`. Permissive when unregistered. */
export type AppDBSchema = [Registered] extends [never]
  ? MapOf<MapOf<any>>
  : Registered extends { DBSchema: infer T }
    ? T
    : MapOf<MapOf<any>>

/** Per-table union of column names that have defaults (optional on insert). */
export type AppDBOptionals = [Registered] extends [never]
  ? MapOf<any>
  : Registered extends { DBOptionals: infer T }
    ? T
    : MapOf<any>

/** Union of table names that are views (excluded from mutation targets). */
export type AppViews = [Registered] extends [never]
  ? never
  : Registered extends { Views: infer T }
    ? T
    : never
