import { describe, expect, test } from 'bun:test'
import {
  describeIdentity,
  isAddressable,
  type TableIntrospection,
} from './identity'

/**
 * `describeIdentity` takes the shapes the adapter reports, camel-cased keys and
 * all, so these fixtures are written the way `getConstraints()` and
 * `getIndexes()` actually spell them — which is the trap the function exists to
 * absorb, and would be hidden by a fixture that pre-resolved the names.
 */

const table = (over: Partial<TableIntrospection> = {}): TableIntrospection => ({
  name: 'parcels',
  constraints: {} as TableIntrospection['constraints'],
  indexes: [],
  columns: [],
  ...over,
})

describe('primary keys', () => {
  test('a single-column key', () => {
    expect(
      describeIdentity(
        table({
          columns: ['id', 'courier'],
          constraints: {
            id: { type: 'integer', primary: true, nullable: false },
            courier: { type: 'string', nullable: false },
          } as any,
        }),
      ),
    ).toEqual({ mode: 'pk', cols: ['id'] })
  })

  test('a composite key is normal, and every member is carried', () => {
    // The dashboard addresses a MySQL row by the *first* primary-key column,
    // so one edit rewrites every row sharing it. This is that bug's assertion.
    expect(
      describeIdentity(
        table({
          name: 'parcel_legs',
          columns: ['parcel_id', 'leg_no', 'carrier'],
          constraints: {
            parcelId: { type: 'integer', primary: true, nullable: false },
            legNo: { type: 'integer', primary: true, nullable: false },
            carrier: { type: 'string', nullable: false },
          } as any,
        }),
      ),
    ).toEqual({ mode: 'pk', cols: ['parcel_id', 'leg_no'] })
  })

  test('the raw column names are returned, not the camel keys', () => {
    const identity = describeIdentity(
      table({
        columns: ['order_ref'],
        constraints: { orderRef: { type: 'string', primary: true } } as any,
      }),
    )
    expect(identity.cols).toEqual(['order_ref'])
  })
})

describe('unique indexes, when there is no primary key', () => {
  test('the narrowest all-NOT-NULL unique index wins', () => {
    const identity = describeIdentity(
      table({
        name: 'emails',
        columns: ['address', 'tenant', 'slug'],
        constraints: {
          address: { type: 'string', nullable: false },
          tenant: { type: 'string', nullable: false },
          slug: { type: 'string', nullable: false },
        } as any,
        indexes: [
          { name: 'uxWide', type: 'unique', cols: ['tenant', 'slug'] },
          { name: 'uxAddress', type: 'unique', cols: ['address'] },
        ],
      }),
    )
    expect(identity).toEqual({ mode: 'unique', cols: ['address'] })
  })

  test('a nullable column disqualifies its index', () => {
    // `NULL = NULL` is unknown, so the predicate would match no row and every
    // update would report zero changes — indistinguishable from a conflict.
    const identity = describeIdentity(
      table({
        columns: ['address'],
        constraints: { address: { type: 'string', nullable: true } } as any,
        indexes: [{ name: 'ux', type: 'unique', cols: ['address'] }],
      }),
    )
    expect(identity.mode).toBe('none')
  })

  test('a column reporting no nullability at all is treated as unusable', () => {
    // Fail closed (convention 2): silence is not "NOT NULL".
    const identity = describeIdentity(
      table({
        columns: ['address'],
        constraints: { address: { type: 'string' } } as any,
        indexes: [{ name: 'ux', type: 'unique', cols: ['address'] }],
      }),
    )
    expect(identity.mode).toBe('none')
  })

  test('a non-unique index is never an identity', () => {
    const identity = describeIdentity(
      table({
        columns: ['address'],
        constraints: { address: { type: 'string', nullable: false } } as any,
        indexes: [{ name: 'ix', type: 'index', cols: ['address'] }],
      }),
    )
    expect(identity.mode).toBe('none')
  })
})

describe('no identity at all', () => {
  test('a table with neither is read-only, with a reason', () => {
    const identity = describeIdentity(
      table({
        name: 'notes',
        columns: ['body'],
        constraints: { body: { type: 'string', nullable: true } } as any,
      }),
    )
    expect(identity.mode).toBe('none')
    expect(identity.cols).toEqual([])
    expect(identity.reason).toContain('no way to name one row')
  })

  test('a view is always none, whatever columns it reports', () => {
    // `getConstraints()` includes views, flagged with `_view`.
    const identity = describeIdentity(
      table({
        name: 'busy_couriers',
        columns: ['id'],
        constraints: {
          _view: 'SELECT id FROM parcels',
          id: { type: 'integer', primary: true, nullable: false },
        } as any,
      }),
    )
    expect(identity.mode).toBe('none')
    expect(identity.reason).toContain('view')
  })

  test('rowid, ctid and oid are never invented as a fallback', () => {
    const identity = describeIdentity(
      table({ name: 'notes', columns: ['body'], constraints: {} as any }),
    )
    expect(identity.cols).toEqual([])
  })
})

describe('addressability', () => {
  test('an identifier qId would rewrite is refused rather than guessed at', () => {
    // `qId` snake-cases before quoting, so `Orders` is written as `orders` —
    // a different object on a case-sensitive MySQL install.
    expect(isAddressable('parcel_legs')).toBe(true)
    expect(isAddressable('id')).toBe(true)
    expect(isAddressable('Orders')).toBe(false)
    expect(isAddressable('legNo')).toBe(false)
  })

  test('a table whose name does not survive quoting has no identity', () => {
    const identity = describeIdentity(
      table({
        name: 'Orders',
        columns: ['id'],
        constraints: { id: { type: 'integer', primary: true } } as any,
      }),
    )
    expect(identity.mode).toBe('none')
    expect(identity.reason).toContain('not addressable')
  })
})
