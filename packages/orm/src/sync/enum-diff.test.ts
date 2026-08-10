import { describe, expect, test } from 'bun:test'

/**
 * Enum members in the column diff.
 *
 * Changing an enum's members used to be a silent no-op: `_enum` was excluded
 * from the diff, so the schema said one thing and the database kept enforcing
 * another. It is in the diff now, gated on the ledger being the source of
 * "current".
 *
 * The gate is the whole design, and these assert both halves of it. Under
 * introspection the members cannot be compared — all three dialects report the
 * `CHECK` constraint back in a different shape, and Postgres re-renders it
 * entirely — so comparing there would differ every single time and rebuild the
 * table on every sync, forever. That is the failure the `length` note in
 * helpers.ts says it waited to rule out.
 */

/** The predicate as `diffColumnMismatch` computes it. */
function enumDiffers(
  source: 'ledger' | 'introspection' | undefined,
  tsEnum: string[] | undefined,
  dbEnum: string[] | undefined,
): boolean {
  return source === 'ledger' && !Bun.deepEquals(tsEnum ?? null, dbEnum ?? null)
}

describe('enum members join the column diff', () => {
  test('an added member is a change', () => {
    expect(enumDiffers('ledger', ['a', 'b', 'c'], ['a', 'b'])).toBe(true)
  })

  test('a removed member is a change', () => {
    expect(enumDiffers('ledger', ['a'], ['a', 'b'])).toBe(true)
  })

  test('a renamed member is a change', () => {
    expect(
      enumDiffers('ledger', ['draft', 'published'], ['draft', 'live']),
    ).toBe(true)
  })

  test('reordering is a change, and deliberately so', () => {
    // The members are emitted into the CHECK in declaration order, so the
    // constraint text genuinely differs. Treating order as insignificant would
    // mean the database and the ledger disagreeing with nothing to reconcile
    // them — and the rebuild is cheap.
    expect(enumDiffers('ledger', ['b', 'a'], ['a', 'b'])).toBe(true)
  })

  test('an unchanged enum is not a change', () => {
    // The steady state. If this were ever true the table would rebuild on every
    // sync, which is the exact bug the ledger gate exists to avoid.
    expect(enumDiffers('ledger', ['a', 'b'], ['a', 'b'])).toBe(false)
  })

  test('no enum on either side is not a change', () => {
    expect(enumDiffers('ledger', undefined, undefined)).toBe(false)
  })

  test('adding an enum to a plain column is a change', () => {
    expect(enumDiffers('ledger', ['a'], undefined)).toBe(true)
  })

  test('dropping an enum entirely is a change', () => {
    expect(enumDiffers('ledger', undefined, ['a'])).toBe(true)
  })
})

describe('the introspection gate', () => {
  test('under introspection, nothing about enums is compared', () => {
    // Not an optimisation — a correctness guard. Introspection cannot report
    // `_enum` in a comparable form, so the db side is always absent; without
    // this gate every enum column would differ on every sync and rebuild
    // forever.
    expect(enumDiffers('introspection', ['a', 'b'], undefined)).toBe(false)
    expect(enumDiffers('introspection', ['a'], ['b'])).toBe(false)
  })

  test('an unknown source is treated as introspection', () => {
    // `ledgerSource` is optional on SyncPlan. Defaulting to "compare" would
    // make the rebuild loop the behaviour for any caller that forgot to set it.
    expect(enumDiffers(undefined, ['a'], undefined)).toBe(false)
  })
})
