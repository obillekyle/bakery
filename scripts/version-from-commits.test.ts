import { describe, expect, test } from 'bun:test'
import {
  applyBump,
  classify,
  highestBump,
  nextVersion,
  versionFromBranch,
} from './version-from-commits'

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

describe('release: as the major marker', () => {
  test('release is a major, with or without a scope', () => {
    expect(classify(c('release: 2.0'))).toBe('major')
    expect(classify(c('release(orm): drop the legacy adapter'))).toBe('major')
  })

  test('the bang still works — it was not replaced', () => {
    // Five commits in this history already use `!`. Retiring it in favour of
    // `release:` would silently reclassify every one of them as non-breaking.
    expect(classify(c('feat!: x'))).toBe('major')
    expect(classify(c('feat: x', 'BREAKING CHANGE: y'))).toBe('major')
  })

  test('"released" and "releases" are not it', () => {
    // The type is matched whole. A prefix match would make `released: notes`
    // cut a major by accident.
    expect(classify(c('released: notes'))).toBeNull()
    expect(classify(c('releases: tidy'))).toBeNull()
  })
})

describe('versionFromBranch', () => {
  test('reads base and channel off the branch name', () => {
    expect(versionFromBranch('1.2.0-beta')).toEqual({
      base: '1.2.0',
      channel: 'beta',
    })
    expect(versionFromBranch('2.0.0-alpha')).toEqual({
      base: '2.0.0',
      channel: 'alpha',
    })
    expect(versionFromBranch('1.0.1-rc')).toEqual({
      base: '1.0.1',
      channel: 'rc',
    })
  })

  test('tolerates the v and release/ prefixes', () => {
    expect(versionFromBranch('v1.2.0-beta')?.base).toBe('1.2.0')
    expect(versionFromBranch('release/1.2.0-beta')?.base).toBe('1.2.0')
    expect(versionFromBranch('release/v1.2.0-beta')?.base).toBe('1.2.0')
  })

  test('declares nothing for ordinary branch names', () => {
    // The important half. Anything unrecognised must fall through to the
    // computed version rather than guess — a feature branch called `1.2.0-fix`
    // is not a release channel.
    for (const name of [
      'main',
      'master',
      'framework/reorganized',
      'feat/window-functions',
      '1.2.0',
      '1.2.0-fix',
      '1.2-beta',
      'beta',
      '',
    ]) {
      expect(versionFromBranch(name)).toBeNull()
    }
  })

  test('carries no counter — only the channel', () => {
    // `1.2.0-beta` says which channel, never which beta. If it carried the
    // number, every cut from the branch would be beta.0 forever.
    expect(versionFromBranch('1.2.0-beta.3')).toBeNull()
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

describe('nextVersion — stable', () => {
  test('is the bump applied to the last stable release', () => {
    const at = (bump: 'major' | 'minor' | 'patch') =>
      nextVersion({
        lastStable: '1.2.3',
        bump,
        channel: null,
        current: '1.2.3',
      })

    expect(at('major')).toBe('2.0.0')
    expect(at('minor')).toBe('1.3.0')
    expect(at('patch')).toBe('1.2.4')
  })

  test('graduating a prerelease keeps the base it was testing', () => {
    // **The bug this exists to prevent.** Everyone spent the beta on 1.3.0;
    // releasing 1.3.1 would skip it entirely and leave a version number that
    // was never published as stable. The base comes from lastStable + bump, so
    // the prerelease counter cannot leak into it.
    expect(
      nextVersion({
        lastStable: '1.2.3',
        bump: 'minor',
        channel: null,
        current: '1.3.0-beta.4',
      }),
    ).toBe('1.3.0')
  })

  test('a break during a beta still graduates to a major', () => {
    // The other direction, and the more dangerous one: measuring against the
    // last *tag* (1.3.0-beta.2) would ship this breaking change as 1.3.0.
    expect(
      nextVersion({
        lastStable: '1.2.3',
        bump: 'major',
        channel: null,
        current: '1.3.0-beta.2',
      }),
    ).toBe('2.0.0')
  })
})

describe('nextVersion — prerelease', () => {
  test('opens a channel at .0', () => {
    expect(
      nextVersion({
        lastStable: '1.2.3',
        bump: 'minor',
        channel: 'alpha',
        current: '1.2.3',
      }),
    ).toBe('1.3.0-alpha.0')
  })

  test('continues the counter while base and channel both hold', () => {
    expect(
      nextVersion({
        lastStable: '1.2.3',
        bump: 'minor',
        channel: 'alpha',
        current: '1.3.0-alpha.0',
      }),
    ).toBe('1.3.0-alpha.1')

    expect(
      nextVersion({
        lastStable: '1.2.3',
        bump: 'minor',
        channel: 'alpha',
        current: '1.3.0-alpha.9',
      }),
    ).toBe('1.3.0-alpha.10')
  })

  test('a channel change restarts at .0', () => {
    // 1.3.0-beta.0 must sort above 1.3.0-alpha.7, and it does — but carrying
    // the counter across (beta.8) would work by accident and then break the
    // first time someone opened a channel out of order.
    expect(
      nextVersion({
        lastStable: '1.2.3',
        bump: 'minor',
        channel: 'beta',
        current: '1.3.0-alpha.7',
      }),
    ).toBe('1.3.0-beta.0')
  })

  test('a base change mid-channel restarts at .0', () => {
    // A `feat!` lands during the 1.3.0 alpha: the base moves to 2.0.0 and the
    // counter cannot continue, because 2.0.0-alpha.4 would imply three earlier
    // 2.0.0 alphas that never existed.
    expect(
      nextVersion({
        lastStable: '1.2.3',
        bump: 'major',
        channel: 'alpha',
        current: '1.3.0-alpha.3',
      }),
    ).toBe('2.0.0-alpha.0')
  })

  test('never produces a version that sorts below the current one', () => {
    // The invariant behind the two restart rules, asserted directly rather than
    // trusted: whatever the transition, the result must be a semver increase.
    const cases = [
      {
        current: '1.3.0-alpha.0',
        channel: 'alpha' as const,
        bump: 'minor' as const,
      },
      {
        current: '1.3.0-alpha.7',
        channel: 'beta' as const,
        bump: 'minor' as const,
      },
      {
        current: '1.3.0-alpha.3',
        channel: 'alpha' as const,
        bump: 'major' as const,
      },
      { current: '1.3.0-beta.1', channel: null, bump: 'minor' as const },
    ]

    for (const { current, channel, bump } of cases) {
      const next = nextVersion({ lastStable: '1.2.3', bump, channel, current })
      expect(Bun.semver.order(next, current)).toBe(1)
    }
  })
})
