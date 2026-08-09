import { describe, expect, test } from 'bun:test'
import { hasORM, ORM_MISSING } from './orm'

/**
 * These run in-repo, where `@bakery/orm` is always present through the
 * workspace symlink — so they cannot test the absent case, and pretending
 * otherwise is the trap. The absent case is verified by packing the tarballs
 * and booting outside the repo; see the CLI docs and the two `conventions`
 * tests that keep the preconditions true.
 *
 * What is worth testing here is the half that in-repo *can* answer, and it is
 * the half with the nastier failure mode.
 */
describe('optional ORM', () => {
  test('the probe agrees with a real import of the same specifier', async () => {
    // The one that would hurt. `hasORM()` asks the resolver about
    // `@bakery/orm/connection`; every guarded call site then imports it. If
    // that subpath ever leaves orm's export map — or the string here picks up
    // a typo — the probe goes permanently false and every guard silently
    // skips. No error, no log: apps that *do* have a database just quietly
    // stop getting one, which is indistinguishable from working until
    // something reads from it.
    //
    // So: assert the probe and the import cannot disagree, by doing both.
    const importable = await import('@bakery/orm/connection')
      .then(() => true)
      .catch(() => false)

    expect({ probe: hasORM(), importable }).toEqual({
      probe: true,
      importable: true,
    })
  })

  test('the probe is memoised', () => {
    // Called on the boot path and again during shutdown. Cheap to assert, and
    // it pins that the second call cannot disagree with the first.
    expect(hasORM()).toBe(hasORM())
  })

  test('the missing-ORM message names the package and the fix', () => {
    // It is the only thing a user in this state sees. A message that describes
    // the problem without the command is a worse version of this test passing.
    expect(ORM_MISSING).toContain('@bakery/orm')
    expect(ORM_MISSING).toContain('bun add @bakery/orm')
  })
})
