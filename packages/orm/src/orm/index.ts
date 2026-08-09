/**
 * **Import order is load-bearing here, and alphabetical order is wrong.**
 *
 * `query.ts` and `mutation.ts` are a cycle: `query.ts` ends with
 * `export const Insert = Mutation.Insert`, read at module top level, and
 * `mutation.ts` imports `DB` from `query.ts`. Whichever this barrel names first
 * is the one that evaluates first.
 *
 * `./query` first works. `./mutation` first does not: `mutation.ts` pulls in
 * `query.ts`, whose top-level `Mutation.Insert` runs while `Mutation` is still
 * initialising, and the whole ORM dies with
 * `TypeError: undefined is not an object (evaluating 'Mutation.Insert')`.
 *
 * Biome's `organizeImports` sorts these alphabetically and puts `./mutation`
 * first. That happened during the 2026-08-09 sweep and cost 12 tests; the
 * compiler cannot see it, because the types are fine either way. Hence the
 * suppression.
 */
// biome-ignore-all assist/source/organizeImports: cycle — see above
import { DB } from './query'
import { Mutation } from './mutation'

export default DB
export { DB, Mutation }
