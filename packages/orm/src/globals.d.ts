import type { AppDBOptionals, AppDBSchema } from './schema-registry'

/**
 * Ambient database types.
 *
 * These live with the orm package rather than in core's `global.d.ts`: they are
 * derived from this package's schema registry, and core cannot reference orm —
 * orm depends on core, so the reverse would be circular.
 *
 * Both are read only inside this package (`orm/query.ts`, `orm/mutation.ts`,
 * `sync/builder.ts`), which is what makes moving them contained.
 */
declare global {
  /** Table map, permissive until an app registers its schema. */
  type DBSchema = AppDBSchema
  /** Per-table union of columns that are optional on insert. */
  type DBOptionals = AppDBOptionals
}

// No `export {}` needed: the `import type` above already makes this a module,
// which is what `declare global` requires. Adding one as well is the reflex,
// and it is what `noUselessEmptyExport` flags.
