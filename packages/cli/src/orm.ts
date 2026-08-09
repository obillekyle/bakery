/**
 * Is `@bakery/orm` installed?
 *
 * The CLI declares it as an **optional peer**, so an app scaffolded with
 * `--no-orm` never downloads it. Every use of it in this package is already an
 * `await import()`, so its absence is not a module-graph problem — it is a
 * question this file answers once, before anything tries.
 *
 * **Absence and breakage must not be conflated, and telling them apart is the
 * only reason this file exists.** The obvious implementation is to wrap the
 * `await import()` in a try and treat a throw as "not installed", and it is
 * wrong in the direction that costs data: a database that is configured but
 * unreachable, a `DB_URL` with a typo, a schema module that throws at import —
 * all of those would be swallowed as "no ORM here" and the server would boot
 * happily with no database and no complaint. `initDB` failing has always been
 * fatal and stays fatal. Only *resolution* failing is soft.
 *
 * So the question is asked of the resolver, which cannot be answered wrongly by
 * a broken database: either the specifier resolves to a file on disk or it does
 * not.
 */

let resolved: boolean | null = null

/**
 * True when `@bakery/orm` can be resolved from this package.
 *
 * Memoised: it is asked on the boot path and once more per shutdown, the answer
 * cannot change within a process, and the filesystem walk is not free.
 *
 * `import.meta.dir` is the resolution base on purpose — it is what a real
 * `import` from this module would use, so the answer matches what the `await
 * import()` calls below it will actually do. Resolving from `process.cwd()`
 * would ask a different question (does the *app* see it) and could disagree,
 * which is the kind of near-miss that produces a "sometimes it works" report.
 */
export function hasORM(): boolean {
  if (resolved !== null) return resolved
  try {
    // The subpath, not the package root: `exports` can name one and not the
    // other, and this is the one every caller here actually imports.
    Bun.resolveSync('@bakery/orm/connection', import.meta.dir)
    resolved = true
  } catch {
    // Not installed. The only expected outcome of this catch, and the reason
    // it is allowed to be silent — see the note above about what is *not*
    // routed through here.
    resolved = false
  }
  return resolved
}

/**
 * What to print when something needs the ORM and it is not there.
 *
 * One string, so the instruction is identical wherever it surfaces. It names
 * the package rather than describing it: the fix is a single `bun add` and the
 * message should be copy-pasteable.
 */
export const ORM_MISSING =
  'This needs @bakery/orm, which is not installed. It is an optional peer ' +
  'dependency of the CLI, so an app scaffolded without a database does not ' +
  'carry it. Add it with `bun add @bakery/orm`.'
