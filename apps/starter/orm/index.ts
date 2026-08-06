import type { InferOptionals, InferSchema, InferViews } from '@bakery/orm'
import * as model from './schema'

export * from './schema'
export * from './indexes'
// foreign() is rejected by db:sync until FK DDL exists — see MONOREPO.md

declare module '@bakery/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: InferSchema<typeof model>
      DBOptionals: InferOptionals<typeof model>
      Views: InferViews<typeof model>
    }
  }
}
