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

  if (m.groups.bang || /^BREAKING[ -]CHANGE:/m.test(body)) return 'major'
  if (m.groups.type === 'feat') return 'minor'
  if (m.groups.type === 'fix' || m.groups.type === 'perf') return 'patch'
  return null
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
 * Apply a bump to a version.
 *
 * No 0.x special case, deliberately. Semver treats a break below 1.0.0 as a
 * minor bump, but this project is at 1.0.0 and cannot go back, so that branch
 * would be unreachable code wearing the costume of a rule.
 *
 * Any prerelease or build metadata on the current version is dropped, which is
 * what a bump means: `1.2.0-rc.1` + patch is `1.2.1`, not `1.2.1-rc.1`.
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
