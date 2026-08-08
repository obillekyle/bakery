import type { InferOptionals, InferSchema, InferViews } from '@bakery/orm'
import * as tables from './tables'
import * as views from './views'

export * from './tables'
export * from './views'
export * from './indexes'

/**
 * Tables *and* views, because the three inferred types need different halves:
 * `InferSchema` reads both (a view is readable like a table), and `InferViews`
 * reads the views specifically — that is what excludes them from
 * `DB.Insert.into(...)`. Importing only `./tables` here would leave the view
 * exclusion silently empty.
 *
 * `./indexes` is re-exported but not inferred: `db:sync` reads the index and
 * foreign-key declarations at runtime, and an index that is declared but never
 * exported is invisible to sync, which then drops the one in the database as
 * undeclared.
 */
type Model = typeof tables & typeof views

declare module '@bakery/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: InferSchema<Model>
      DBOptionals: InferOptionals<Model>
      Views: InferViews<Model>
    }
  }
}
