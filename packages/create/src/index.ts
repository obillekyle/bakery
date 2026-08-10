#!/usr/bin/env bun

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { confirm, isInteractive, multiselect } from './prompt'
import {
  dependencyRange,
  isValidAppName,
  PLUGIN_IDS,
  type PluginId,
  type TemplateFile,
  templateFiles,
} from './template'

/**
 * `bun create bakery <dir>`.
 *
 * `bun create x` fetches `create-x` and runs its bin with the remaining
 * arguments, which is the whole reason this is a separate unscoped package
 * rather than another verb on the `bakery` bin: `@bakery-framework/cli` owns that bin,
 * and it is a dependency of the app you are trying to create.
 *
 * Deliberately dependency-free. `bun create` downloads this package on its own,
 * so anything it depends on is a download the user waits through before seeing
 * a single file — and the framework it scaffolds is the last thing it should
 * drag along.
 */

const HELP = `bun create bakery <directory>

Scaffold a Bakery app.

Run it without --orm/--no-orm or --plugins and it asks, so long as you are at a
terminal. Pass either and it stops asking about that one; pass --yes and it
stops asking entirely.

Arguments:
  <directory>       Where to create it. Also the package name, unless --name
                    is given. Use "." for the current directory.

Options:
  --name <name>     Package name, when it should differ from the directory.
  --orm             Include the ORM: orm/, db:sync, @bakery-framework/orm.
  --no-orm          Leave it out. The example API route keeps posts in memory.
  --plugins <list>  Comma-separated, from: ${PLUGIN_IDS.join(', ')}.
                    Use --plugins none for an explicit empty set.
  --yes, -y         Take the defaults for anything not passed (ORM in, no
                    plugins). What a non-interactive shell does anyway.
  --no-install      Write the files and stop, without running bun install.
  -h, --help        This.

Examples:
  bun create bakery my-app
  bun create bakery my-app --no-orm --plugins vue
  bun create bakery . --name my-app --plugins dashboard,analytics
  bun create bakery my-app --yes
`

type Options = {
  dir: string
  name: string
  install: boolean
  /** `null` means "not specified" — ask, or fall back to the default. */
  orm: boolean | null
  plugins: PluginId[] | null
  yes: boolean
}

/**
 * Parse one `--plugins` value into the ids it names.
 *
 * Split out of `parseArgs` because it is the only flag that validates rather
 * than assigns, and inlining it put the loop over the complexity limit — which
 * is the rule doing its job: a `for` over argv should read as a dispatch table.
 */
function parsePlugins(
  value: string,
): { ok: true; plugins: PluginId[] } | { ok: false; message: string } {
  // `none` rather than an empty string, so "I want no plugins" is something you
  // can state — an empty `--plugins=` reads like a mistake and is treated as one
  // by the caller, which rejects an empty value before reaching here.
  if (value === 'none') return { ok: true, plugins: [] }

  const requested = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const unknown = requested.filter(p => !PLUGIN_IDS.includes(p as PluginId))
  if (unknown.length) {
    return {
      ok: false,
      message:
        `Unknown plugin${unknown.length > 1 ? 's' : ''}: ` +
        `${unknown.join(', ')}. Available: ${PLUGIN_IDS.join(', ')}.`,
    }
  }

  // De-duplicated and put in a fixed order, so `--plugins dashboard,vue` and
  // `--plugins vue,dashboard` generate byte-identical apps.
  return { ok: true, plugins: PLUGIN_IDS.filter(id => requested.includes(id)) }
}

/**
 * Parse argv into options, or return a message to print and exit on.
 *
 * Returns rather than throws for a *usage* problem: a bad flag is a thing the
 * user typed, and answering it with a stack trace teaches nothing. Throwing is
 * reserved for a failure of the scaffolding itself.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: argv dispatcher — one branch per flag
export function parseArgs(
  argv: string[],
): { ok: true; options: Options } | { ok: false; message: string } {
  let dir: string | null = null
  let name: string | null = null
  let install = true
  let orm: boolean | null = null
  let plugins: PluginId[] | null = null
  let yes = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '-h' || arg === '--help') return { ok: false, message: HELP }

    if (arg === '--no-install') {
      install = false
      continue
    }

    if (arg === '--yes' || arg === '-y') {
      yes = true
      continue
    }

    if (arg === '--orm' || arg === '--no-orm') {
      orm = arg === '--orm'
      continue
    }

    if (arg === '--plugins' || arg.startsWith('--plugins=')) {
      const value = arg.startsWith('--plugins=') ? arg.slice(10) : argv[++i]
      if (!value) {
        return {
          ok: false,
          message: `--plugins needs a value: ${PLUGIN_IDS.join(', ')}, or none.`,
        }
      }
      const parsed = parsePlugins(value)
      if (!parsed.ok) return parsed
      plugins = parsed.plugins
      continue
    }

    if (arg === '--name' || arg.startsWith('--name=')) {
      const value = arg.startsWith('--name=') ? arg.slice(7) : argv[++i]
      if (!value) return { ok: false, message: '--name needs a value.' }
      name = value
      continue
    }

    if (arg.startsWith('-')) {
      return { ok: false, message: `Unknown option: ${arg}\n\n${HELP}` }
    }

    if (dir !== null) {
      return { ok: false, message: `Unexpected argument: ${arg}\n\n${HELP}` }
    }
    dir = arg
  }

  if (dir === null) return { ok: false, message: HELP }

  // `.` is the documented way to scaffold in place, and `basename(resolve('.'))`
  // is the containing folder's name — which is the name the user means.
  const resolved = resolve(dir)
  const appName = name ?? basename(resolved)

  if (!isValidAppName(appName)) {
    return {
      ok: false,
      message:
        `"${appName}" is not a usable package name: lowercase letters, ` +
        'digits, dot, dash and underscore only, and it may not start with a ' +
        'dot or a dash. Pass --name to choose a different one.',
    }
  }

  return {
    ok: true,
    options: { dir: resolved, name: appName, install, orm, plugins, yes },
  }
}

/**
 * Fill in whatever the flags left unspecified.
 *
 * Asks only when there is a terminal on both ends and `--yes` was not passed.
 * A pipe, a CI runner or a `--yes` takes the defaults — ORM in, no plugins —
 * which is what `bun create bakery my-app` has always produced, so adding the
 * prompts changed no existing invocation.
 *
 * Returns `null` when the user cancels, which is a distinct outcome from
 * "chose nothing" and has to stay that way: Ctrl-C should not scaffold.
 */
export async function resolveChoices(
  options: Options,
): Promise<{ orm: boolean; plugins: PluginId[] } | null> {
  const interactive = !options.yes && isInteractive()

  let orm = options.orm
  if (orm === null) {
    if (!interactive) orm = true
    else {
      const answer = await confirm('Include the ORM?', true)
      if (answer === null) return null
      orm = answer
    }
  }

  let plugins = options.plugins
  if (plugins === null) {
    if (!interactive) plugins = []
    else {
      const chosen = await multiselect('Plugins', [
        { id: 'vue', label: 'vue', hint: 'single-file components' },
        { id: 'analytics', label: 'analytics', hint: 'request metrics' },
        { id: 'dashboard', label: 'dashboard', hint: 'admin console' },
      ])
      if (chosen === null) return null
      plugins = PLUGIN_IDS.filter(id => chosen.includes(id))
    }
  }

  return { orm, plugins }
}

/**
 * True when `dir` does not exist, or exists and holds nothing that would be
 * overwritten.
 *
 * Scaffolding is the one operation where "the directory already had something
 * in it" is almost always a mistake, and it is not undoable — so this refuses
 * rather than merges or prompts. `.git` and the editor droppings people
 * routinely create a directory with are ignored, because refusing on those
 * makes `git init && bun create bakery .` fail for no reason.
 */
export async function isScaffoldable(dir: string): Promise<boolean> {
  const IGNORED = new Set(['.git', '.gitkeep', '.DS_Store', 'Thumbs.db'])

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // Does not exist, which is the common case and the good one. A permission
    // error also lands here and is caught properly by the write that follows —
    // reporting it as "not empty" would be a worse message than the real one.
    return true
  }

  return entries.every(entry => IGNORED.has(entry))
}

/** Write the template. Directories are created as needed. */
export async function writeTemplate(
  dir: string,
  files: TemplateFile[],
): Promise<void> {
  for (const file of files) {
    const target = resolve(dir, file.path)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, file.contents)
  }
}

/**
 * This package's own version, which the generated dependency range follows.
 *
 * Exported only so a test can prove it still reads the right file: the relative
 * URL breaks silently if this module moves, and the failure is a generated app
 * pinned to the wrong major with every other test still green.
 */
export async function ownVersion(): Promise<string> {
  const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json()
  return pkg.version
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))

  if (!parsed.ok) {
    // The only console use in this package, and the reason the framework's
    // no-console rule scopes itself to server code: this is a CLI whose entire
    // output is for a human at a terminal, with no logger to route it through.
    console.log(parsed.message)
    return parsed.message === HELP ? 0 : 1
  }

  const { dir, name, install } = parsed.options

  // Checked before the prompts, not after: asking someone three questions and
  // then refusing because the directory was never usable is the rudest possible
  // ordering.
  if (!(await isScaffoldable(dir))) {
    console.log(
      `${dir} already has files in it. Bakery will not scaffold over an ` +
        'existing directory — pick an empty one, or empty this one first.',
    )
    return 1
  }

  const choices = await resolveChoices(parsed.options)
  if (!choices) {
    console.log('\nCancelled. Nothing was written.')
    return 130
  }

  const files = templateFiles(
    name,
    dependencyRange(await ownVersion()),
    choices,
  )
  await writeTemplate(dir, files)

  const summary = [
    choices.orm ? 'with the ORM' : 'without the ORM',
    choices.plugins.length ? `plugins: ${choices.plugins.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(', ')
  console.log(`Created ${name} in ${dir} (${summary})`)

  if (install) {
    const proc = Bun.spawn(['bun', 'install'], {
      cwd: dir,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const code = await proc.exited
    if (code !== 0) {
      console.log(
        '\nbun install failed. The app is written — run it again in ' +
          `${dir} once the problem is fixed.`,
      )
      return code
    }
  }

  const cd = dir === process.cwd() ? '' : `  cd ${basename(dir)}\n`
  console.log(
    `\nNext:\n\n${cd}${install ? '' : '  bun install\n'}` +
      `${choices.orm ? '  bun run db:sync\n' : ''}  bun run dev\n`,
  )

  return 0
}

if (import.meta.main) process.exit(await main())
