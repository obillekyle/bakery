import { DB, Mutation } from './orm'

export default DB
export { DB, Mutation }

/**
 * Schema authoring, from one place.
 *
 * `table`/`alias` live in `define.ts` and the column and constraint helpers in
 * `schema-util.ts`, but that split is an implementation detail — someone
 * writing `orm/schema.ts` should import from `@bakery/orm` without having to
 * know which file a helper happens to sit in.
 */
export { alias, table } from './define'
export type {
  InferOptionals,
  InferSchema,
  InferViews,
  TableColumn,
  TableDef,
} from './define'

export {
  col,
  dateNow,
  foreign,
  index,
  old,
  primary,
  unique,
  value,
} from './schema-util'
export type {
  ExtractOptionals,
  ExtractTableTypes,
  ExtractViews,
} from './schema-util'
