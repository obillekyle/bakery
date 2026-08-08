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
export { alias, table, view } from './define'
export { Field } from './field'
export type {
  InferOptionals,
  InferSchema,
  InferViews,
  InsertOf,
  RowOf,
  TableColumn,
  TableDef,
} from './define'

export {
  col,
  dateNow,
  old,
} from './schema-util'
export type {
  ExtractOptionals,
  ExtractTableTypes,
  ExtractViews,
} from './schema-util'

/**
 * Query observability.
 *
 * Re-exported from the root rather than given a `./observe` subpath. The
 * export map is closed and every entry in it is public API from the moment it
 * ships, so a new subpath needs a reason — and there is none here: this is one
 * function and three types, the observer is process-wide, and an app sets it
 * once at boot next to where it already imports `DB`. `./adapters` is not
 * public and is not being opened up to make this reachable.
 */
export { getQueryObserver, setQueryObserver } from './adapters/observe'
export type {
  QueryEvent,
  QueryMethod,
  QueryObserver,
  QueryObserverOptions,
} from './adapters/observe'
