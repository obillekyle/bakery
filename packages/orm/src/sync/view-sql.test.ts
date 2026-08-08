import { describe, expect, test } from 'bun:test'
import { formatViewBody, normalizeViewBody } from './view-sql'

/**
 * A view body is compared as text, so normalising it is only safe if the result
 * is **convergent** — what you write and what the server hands back reduce to
 * the same string — and **idempotent**. Break either and the view is recreated
 * on every sync, forever.
 *
 * The fixture is the canonical form MySQL returns for a real aggregated view:
 * fully qualified, fully quoted, every column aliased to itself, JSON
 * aggregates and casts throughout. Verified against seven live views before
 * being written down here.
 */
const CANONICAL =
  "select `p`.`id` AS `id`,`p`.`name` AS `name`," +
  "coalesce(nullif(`p`.`images`,''),json_array()) AS `images`," +
  "cast(coalesce(`v`.`stock`,0) as unsigned) AS `stock`," +
  "json_arrayagg(json_object('id',`shop`.`variants`.`id`)) AS `variants` " +
  'from ((`shop`.`products` `p` left join (select `shop`.`variants`.`product` AS `product`,' +
  'sum(`shop`.`variants`.`stock`) AS `stock` from `shop`.`variants` ' +
  'group by `shop`.`variants`.`product`) `v` on((`p`.`id` = `v`.`product`)))) ' +
  'where ((`p`.`published` = 1) and (`p`.`deleted_at` is null))'

describe('view body normalisation', () => {
  test('is idempotent', () => {
    const once = normalizeViewBody(CANONICAL, 'shop')
    expect(normalizeViewBody(once, 'shop')).toBe(once)
  })

  test('the formatted body and the canonical one converge', () => {
    // The property the whole design rests on: the file on disk is readable, and
    // the diff still sees it as identical to what the server reports.
    const pretty = formatViewBody(CANONICAL, 'shop')
    expect(normalizeViewBody(pretty, 'shop')).toBe(
      normalizeViewBody(CANONICAL, 'shop'),
    )
    expect(pretty).toContain('\n')
  })

  test('drops quoting from plain identifiers', () => {
    expect(normalizeViewBody('select `a`.`b` from `t`')).toBe('select a.b from t')
    expect(normalizeViewBody('select "a"."b" from "t"')).toBe('select a.b from t')
  })

  test('keeps quoting a reserved word needs', () => {
    // Unquoting this turns an identifier into syntax.
    expect(normalizeViewBody('select `from` from `t`')).toContain('`from`')
  })

  test('strips only the view’s own schema', () => {
    const out = normalizeViewBody(
      'select x from `shop`.`products` join `other`.`t` on 1',
      'shop',
    )
    expect(out).toContain('from products')
    // A cross-database reference is load-bearing and must survive.
    expect(out).toContain('other.t')
  })

  test('a hard-coded schema is why this matters', () => {
    // Left in, the same schema deployed against a differently-named database
    // compares unequal and the view is recreated on every sync.
    expect(normalizeViewBody(CANONICAL, 'shop')).not.toContain('shop.')
  })

  test('collapses an alias that repeats its own column', () => {
    expect(normalizeViewBody('select `p`.`id` AS `id` from `t`')).toBe(
      'select p.id from t',
    )
    // A real rename is not an alias-to-self and must survive.
    expect(normalizeViewBody('select `p`.`id` AS `pid` from `t`')).toContain(
      'AS pid',
    )
  })

  test('an empty body is empty, not the string undefined', () => {
    expect(normalizeViewBody('')).toBe('')
  })
})
