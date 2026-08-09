#!/usr/bin/env bun
/**
 * Bump every publishable package to one version, and roll the changelog.
 *
 *     bun run release 4.1.0
 *     bun run release 4.1.0 --dry-run
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
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

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
const version = args.find(a => !a.startsWith('--'))

function die(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}

// A release number is interpolated into seven manifests and a git tag, so it is
// validated rather than trusted. Prerelease and build metadata are allowed;
// a leading `v` is not, because the tag adds it and `v4.1.0` in a manifest is
// not a valid semver string.
if (!version) die('usage: bun run release <version> [--dry-run] [--skip-gates]')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  die(`'${version}' is not a semver version (no leading 'v')`)
}

async function sh(cmd: string[], label: string) {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  if ((await proc.exited) !== 0) die(`${label} failed`)
}

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
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
