import type { InferOptionals, InferSchema, InferViews } from '@bakery/orm'
import * as model from './schema'

export * from './schema'
export * from './indexes'
// Both files are re-exported because `InferSchema` reads the table values and
// `db:sync` reads the index and foreign-key declarations; an index that is
// declared but never exported is invisible to sync, which then drops the one in
// the database as undeclared.

declare module '@bakery/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: InferSchema<typeof model>
      DBOptionals: InferOptionals<typeof model>
      Views: InferViews<typeof model>
    }
  }
}
