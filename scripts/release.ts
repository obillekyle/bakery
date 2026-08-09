#!/usr/bin/env bun
/**
 * Bump every publishable package to one version, and roll the changelog.
 *
 *     bun run release              # version computed from the commit messages
 *     bun run release --dry-run    # show the computed bump, write nothing
 *     bun run release 1.4.0        # explicit, overrides the computation
 *
 * Does **not** publish. Publishing is seven `bun publish` calls against a
 * registry, and a script that both rewrites the tree and pushes to npm is one
 * typo away from an unpublishable mistake — npm does not allow re-using a
 * version number. This gets the tree to a releasable state and stops.
 *
 * Lockstep is the point: see CHANGELOG.md for why, and
 * `tests/conventions.test.ts` for the check that keeps it true between
 * releases.
 */
import { applyBump, classify, highestBump } from './version-from-commits'

const ROOT = new URL('..', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
)

const PACKAGES = [
  'packages/core',
  'packages/orm',
  'packages/cli',
  'packages/create',
  'packages/plugins/vue',
  'packages/plugins/analytics',
  'packages/plugins/dashboard',
]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const skipGates = args.includes('--skip-gates')
const explicitVersion = args.find(a => !a.startsWith('--'))

function die(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}

async function sh(cmd: string[], label: string) {
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await proc.exited) !== 0) die(`${label} failed`)
}

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

/**
 * Work out the next version from the commits since the last tag.
 *
 * The history is 100% conventional-commit formatted (62/62 at the time this was
 * written), so the types are trustworthy input rather than a guess. An explicit
 * version on the command line still wins — this computes a default, it does not
 * take the decision away.
 *
 * **What it deliberately does not do is write the changelog.** Every tool in
 * this space generates release notes by listing commit subjects, and for this
 * repo that would be a downgrade: CHANGELOG.md explains *why* things are the
 * way they are — which limitation is deliberate, what a fix cost, what was
 * reversed — and no generator can produce that from a subject line. The version
 * number is mechanical and worth automating. The prose is the actual work, and
 * it stays hand-written; the script only opens the heading for it.
 */
async function computeVersion(current: string): Promise<string> {
  const lastTag = await capture(['git', 'describe', '--tags', '--abbrev=0'])
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'

  // \x1e between records, \x1f between fields: a commit body can contain
  // anything, newlines included, so the separators have to be bytes that
  // cannot appear in one.
  const raw = await capture(['git', 'log', range, '--format=%s%x1f%b%x1e'])

  const commits = raw
    .split('\x1e')
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => {
      const [subject = '', body = ''] = r.split('\x1f')
      const commit = { subject, body: body.trim() }
      return { ...commit, bump: classify(commit) }
    })

  console.log(
    `release: ${commits.length} commit(s) since ${lastTag || 'the first commit'}`,
  )

  const driving = commits.filter(c => c.bump)
  if (!driving.length) {
    die(
      `nothing to release — no feat/fix/perf or breaking commit since ${lastTag || 'the first commit'}.\n` +
        '        Pass a version explicitly to override.',
    )
  }

  const bump = highestBump(commits)
  if (!bump) die('unreachable: driving commits but no bump')

  // Show the work. A computed version nobody can check is worse than a typed
  // one: the reason for a major has to be visible before it is tagged.
  for (const level of ['major', 'minor', 'patch'] as const) {
    const at = driving.filter(c => c.bump === level)
    if (at.length) {
      console.log(`  ${level.padEnd(5)} ${at.length}`)
      for (const c of at.slice(0, 3)) console.log(`        ${c.subject}`)
      if (at.length > 3) console.log(`        … and ${at.length - 3} more`)
    }
  }

  const next = applyBump(current, bump)
  console.log(`release: ${current} -> ${next} (${bump})`)
  return next
}

const rootPkg = JSON.parse(await Bun.file(`${ROOT}/package.json`).text())
const version = explicitVersion ?? (await computeVersion(rootPkg.version))

// A release number is interpolated into seven manifests and a git tag, so it is
// validated rather than trusted — including the computed one, which is cheap
// insurance against a bug in the arithmetic above. Prerelease and build
// metadata are allowed; a leading `v` is not, because the tag adds it and
// `v1.1.0` in a manifest is not a valid semver string.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  die(`'${version}' is not a semver version (no leading 'v')`)
}

// 1. A dirty tree means the release would capture edits nobody reviewed.
const status = await capture(['git', 'status', '--porcelain'])
if (status && !dryRun) {
  die(`working tree is not clean:\n${status}`)
}

// 2. The gates. Skippable only explicitly, and the flag is named so that
//    skipping shows up in shell history.
if (!skipGates) {
  console.log('release: running gates…')
  await sh(['bun', 'run', 'typecheck'], 'typecheck')
  await sh(['bun', 'run', 'test'], 'test')
} else {
  console.log('release: gates SKIPPED')
}

// 3. Every manifest, including the private root, so `bakery-monorepo` does not
//    drift away from the packages it contains.
const targets = [...PACKAGES.map(p => `${p}/package.json`), 'package.json']
const changed: string[] = []

for (const rel of targets) {
  const path = `${ROOT}/${rel}`
  const text = await Bun.file(path).text()
  const json = JSON.parse(text)
  const from = json.version
  if (from === version) {
    console.log(`  = ${String(json.name).padEnd(26)} already ${version}`)
    continue
  }
  json.version = version
  if (!dryRun) await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`)
  changed.push(rel)
  console.log(`  ↑ ${String(json.name).padEnd(26)} ${from} -> ${version}`)
}

// 4. Roll `## [Unreleased]` into a dated heading, and open a fresh one.
const changelogPath = `${ROOT}/CHANGELOG.md`
const changelog = await Bun.file(changelogPath).text()
const marker = '## [Unreleased]'
if (!changelog.includes(marker)) die('CHANGELOG.md has no `## [Unreleased]`')

// Date comes from the caller's clock, formatted as ISO-8601 like every other
// heading. Not `toLocaleDateString` — a release note that reads differently
// depending on who cut it is a small lie.
const today = new Date().toISOString().slice(0, 10)
const rolled = changelog.replace(
  marker,
  `${marker}\n\n## [${version}] — ${today}`,
)
if (!dryRun) await Bun.write(changelogPath, rolled)
console.log(`  ✎ CHANGELOG.md    new heading [${version}] — ${today}`)

console.log(
  dryRun
    ? '\nrelease: dry run, nothing written'
    : `\nrelease: ${changed.length} manifest(s) updated.\n` +
        `  next: review the diff, commit, tag v${version},\n` +
        '        then publish each package with `bun publish`.',
)
