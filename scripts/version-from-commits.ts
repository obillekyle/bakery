/**
 * Work out a semver bump from conventional-commit messages.
 *
 * Pure — no git, no filesystem, no process. Separated from `release.ts` for the
 * same reason `template.ts` is separated from `index.ts` and `prompt.ts`'s state
 * machine from its terminal: the interesting logic is a handful of rules, and
 * rules are worth testing exhaustively rather than by running the real thing and
 * squinting at it.
 *
 * That separation is not academic here. Every commit range ending at HEAD in
 * this repo contains a `feat!`, so the major path is the *only* one reachable
 * by running `release.ts` against real history — the minor and patch rules
 * cannot be exercised end to end at all, and would have shipped unverified.
 */

export type Bump = 'major' | 'minor' | 'patch' | null

export interface Commit {
  subject: string
  body: string
}

const RANK: Record<Exclude<Bump, null>, number> = {
  patch: 1,
  minor: 2,
  major: 3,
}

/** `type(scope)!: subject`. The `!` is the part that matters most. */
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: /

/**
 * The bump one commit justifies on its own, or `null` for none.
 *
 * **Both breaking markers are checked, not just the footer.** In this history
 * five commits mark a break with `!` in the subject and only *one* also writes
 * `BREAKING CHANGE:` in the body — so a tool that scans bodies alone (several
 * popular ones do) would miss four majors out of five and quietly ship a
 * breaking change as a patch release.
 *
 * `docs`, `chore`, `refactor`, `test`, `style`, `build` and `ci` produce no
 * bump by themselves: nothing a consumer can observe changed. A `refactor!`
 * still returns major, because the `!` is checked before the type.
 */
export function classify({ subject, body }: Commit): Bump {
  const m = HEADER.exec(subject)
  if (!m?.groups) return null

  // `release:` is this repo's own major marker, alongside the standard `!` and
  // `BREAKING CHANGE:`. It reads oddly next to the others — every other type
  // describes what changed, this one declares an intent — and that is exactly
  // why it is useful: a major is a decision, not a property of a diff.
  //
  // **Both spellings stay valid.** `!` is not dropped in its favour: five
  // commits already in this history use it, external tooling (commitlint,
  // GitHub's own release notes) understands it and understands nothing about
  // `release:`, and retiring it would silently reclassify real breaking
  // changes as ordinary ones.
  if (m.groups.type === 'release') return 'major'
  if (m.groups.bang || /^BREAKING[ -]CHANGE:/m.test(body)) return 'major'
  if (m.groups.type === 'feat') return 'minor'
  if (m.groups.type === 'fix' || m.groups.type === 'perf') return 'patch'
  return null
}

/**
 * The version a branch name declares, if it declares one.
 *
 * `1.2.0-beta`, `v1.2.0-beta`, `release/1.2.0-beta` all mean "this branch is
 * building towards 1.2.0, publishing betas along the way". `main` — or any name
 * that is not a version — declares nothing, and the version is computed from
 * the commits instead.
 *
 * Note what a branch name does **not** carry: a counter. `1.2.0-beta` says the
 * channel, not which beta; the number comes from the version already in the
 * manifests, so cutting the fourth beta from the same branch gives `beta.3` and
 * not `beta.0` forever.
 *
 * The obvious objection to versioning by branch name is worth writing down
 * rather than discovering: **branch names are not history.** They are mutable,
 * they get deleted after merge, and nothing in the repository records that
 * `1.2.0-beta.3` came from one. That is why this is a convenience for choosing
 * the number and never the record of it — the tag is the record, and the
 * release still creates one.
 */
export function versionFromBranch(
  branch: string,
): { base: string; channel: Channel } | null {
  const name = branch
    .trim()
    .replace(/^release\//, '')
    .replace(/^v/, '')
  const m = /^(\d+\.\d+\.\d+)-([a-z]+)$/.exec(name)
  if (!m) return null

  const [, base, channel] = m
  if (!base || !CHANNELS.includes(channel as Channel)) return null
  return { base, channel: channel as Channel }
}

/** The strongest bump across a range, or `null` if nothing justifies a release. */
export function highestBump(commits: Commit[]): Bump {
  let best: Bump = null
  for (const commit of commits) {
    const bump = classify(commit)
    if (bump && (!best || RANK[bump] > RANK[best])) best = bump
  }
  return best
}

/**
 * Apply a bump to a **stable** version.
 *
 * No 0.x special case, deliberately. Semver treats a break below 1.0.0 as a
 * minor bump, but this project is at 1.0.0 and cannot go back, so that branch
 * would be unreachable code wearing the costume of a rule.
 *
 * Prerelease and build metadata on the input are dropped. That is right for the
 * only thing that calls this — it is fed the last *stable* version — and wrong
 * for anything else, which is why `nextVersion` below exists rather than
 * callers reaching for this directly with whatever they have to hand.
 */
export function applyBump(current: string, bump: Exclude<Bump, null>): string {
  const core = current.split(/[-+]/)[0] ?? current
  const [major = 0, minor = 0, patch = 0] = core.split('.').map(Number)

  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    throw new Error(`not a semver version: ${current}`)
  }

  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** Prerelease channels, in semver precedence order — which is also alphabetical. */
export const CHANNELS = ['alpha', 'beta', 'rc'] as const
export type Channel = (typeof CHANNELS)[number]

const PRERELEASE = /^(?<base>\d+\.\d+\.\d+)-(?<channel>[a-z]+)\.(?<n>\d+)$/

/**
 * The next version, stable or prerelease.
 *
 * **The base always comes from the last *stable* release plus the bump across
 * every commit since it — never from the current version.** That is the whole
 * trick, and getting it wrong is the classic prerelease bug in both directions:
 *
 * - Bumping the current version instead means `1.2.0-rc.1` graduates to
 *   `1.2.1`, silently skipping the `1.2.0` everyone was testing.
 * - Only counting commits since the last *tag* means a `feat!` landing during a
 *   beta gets measured against `1.2.0-beta.2`, and ships as `1.2.0` — a
 *   breaking change released as a minor.
 *
 * Computing from the last stable handles both without a special case: the base
 * is recomputed from scratch every time, so escalation just works, and
 * graduating is "the same base, minus the tag".
 *
 * @param lastStable  the last non-prerelease version released
 * @param bump        strongest bump across commits since `lastStable`
 * @param channel     `null` graduates to (or stays) stable
 * @param current     the version in the manifests right now, used only to
 *                    decide whether a prerelease counter continues or restarts
 */
export function nextVersion({
  lastStable,
  bump,
  channel,
  current,
}: {
  lastStable: string
  bump: Exclude<Bump, null>
  channel: Channel | null
  current: string
}): string {
  const base = applyBump(lastStable, bump)
  return channel ? withChannel(base, channel, current) : base
}

/**
 * Attach a prerelease channel and counter to a known base.
 *
 * Split out because the base has two sources — computed from the commits, or
 * declared by a branch name — and the counter rule must not fork with it.
 *
 * Continue the counter only when the base *and* the channel both match. A base
 * change (a break landed mid-beta) or a channel change (beta after alpha)
 * restarts at `.0`; anything else would produce a version sorting below one
 * already published.
 */
export function withChannel(
  base: string,
  channel: Channel,
  current: string,
): string {
  const m = PRERELEASE.exec(current)
  const continuing = m?.groups?.base === base && m.groups.channel === channel
  const n = continuing ? Number(m?.groups?.n) + 1 : 0

  return `${base}-${channel}.${n}`
}
