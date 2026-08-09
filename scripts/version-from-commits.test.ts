import { describe, expect, test } from 'bun:test'
import { applyBump, classify, highestBump } from './version-from-commits'

const c = (subject: string, body = '') => ({ subject, body })

describe('classify', () => {
  test('a bang in the subject is a major, whatever the type', () => {
    // The rule that matters most, and the one most easily lost: four of this
    // repo's five breaking commits carry *only* the bang, with no footer.
    expect(classify(c('feat!: publish as @bakery-framework'))).toBe('major')
    expect(classify(c('refactor!: rename TableDef'))).toBe('major')
    expect(classify(c('fix!: reject a malformed PORT'))).toBe('major')
    expect(classify(c('chore!: drop Bun 1.2 support'))).toBe('major')
  })

  test('a scope does not hide the bang', () => {
    // `feat(cli)!:` is the form that a regex written without the optional scope
    // group silently classifies as a minor.
    expect(classify(c('feat(cli)!: make the ORM optional'))).toBe('major')
    expect(classify(c('refactor(orm,core)!: split adapters'))).toBe('major')
  })

  test('a BREAKING CHANGE footer is a major without a bang', () => {
    expect(
      classify(c('feat: new adapter API', 'BREAKING CHANGE: drops driver()')),
    ).toBe('major')
    // The hyphenated spelling appears in the wild and in some tooling.
    expect(classify(c('feat: x', 'BREAKING-CHANGE: y'))).toBe('major')
  })

  test('the footer must start a line, not appear mid-sentence', () => {
    // Otherwise prose *about* breaking changes silently becomes one — and this
    // repo's commit bodies discuss them constantly.
    expect(
      classify(
        c('fix: tighten the guard', 'This is not a BREAKING CHANGE: it'),
      ),
    ).toBe('patch')
  })

  test('feat is a minor, fix and perf are patches', () => {
    expect(classify(c('feat: add window functions'))).toBe('minor')
    expect(classify(c('feat(orm): add views'))).toBe('minor')
    expect(classify(c('fix: correct .changes on mysql'))).toBe('patch')
    expect(classify(c('perf: cache the resolver probe'))).toBe('patch')
  })

  test('housekeeping types produce no bump on their own', () => {
    for (const subject of [
      'docs: record the ORM decision',
      'chore: gitignore .npmrc',
      'refactor: extract parsePlugins',
      'test: cover the skip path',
      'style: reformat',
      'build: bump biome',
      'ci: add the adapters job',
    ]) {
      expect(classify(c(subject))).toBeNull()
    }
  })

  test('a non-conventional subject is ignored rather than guessed at', () => {
    // Returning `patch` for anything unparseable would turn a typo into a
    // release. Silence is the safe direction: the worst case is a release that
    // has to be asked for explicitly.
    expect(classify(c('Merge branch main'))).toBeNull()
    expect(classify(c('WIP'))).toBeNull()
    expect(classify(c('Feat: capitalised'))).toBeNull()
    expect(classify(c('feat:no space after colon'))).toBeNull()
  })
})

describe('highestBump', () => {
  test('takes the strongest, not the last or the most common', () => {
    expect(
      highestBump([c('fix: a'), c('feat: b'), c('fix: c'), c('docs: d')]),
    ).toBe('minor')

    // One breaking commit buried among twenty patches still yields a major.
    expect(
      highestBump([
        c('fix: a'),
        c('refactor!: b'),
        ...Array.from({ length: 20 }, (_, i) => c(`fix: n${i}`)),
      ]),
    ).toBe('major')
  })

  test('null when nothing in the range is releasable', () => {
    expect(highestBump([c('docs: a'), c('chore: b')])).toBeNull()
    expect(highestBump([])).toBeNull()
  })
})

describe('applyBump', () => {
  test('zeroes the lower components', () => {
    // The bug this pins: `1.4.7` + major must be `2.0.0`, not `2.4.7`.
    expect(applyBump('1.4.7', 'major')).toBe('2.0.0')
    expect(applyBump('1.4.7', 'minor')).toBe('1.5.0')
    expect(applyBump('1.4.7', 'patch')).toBe('1.4.8')
  })

  test('drops prerelease and build metadata', () => {
    expect(applyBump('1.2.0-rc.1', 'patch')).toBe('1.2.1')
    expect(applyBump('1.2.0+build.5', 'minor')).toBe('1.3.0')
  })

  test('refuses a version it cannot parse', () => {
    expect(() => applyBump('not-a-version', 'patch')).toThrow()
  })
})
