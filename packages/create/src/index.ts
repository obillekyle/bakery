#!/usr/bin/env bun

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { confirm, isInteractive, multiselect, text } from './prompt'
import {
  dependencyRange,
  isValidAppName,
  PLUGIN_IDS,
  PLUGINS_NEEDING_ORM,
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
 * a single file, and the framework it scaffolds is the last thing it should
 * drag along.
 */

/** The folder offered when none was given, and taken under `--yes`. */
export const DEFAULT_FOLDER = 'bakery-app'

const HELP = `bun create bakery [directory]

Scaffold a Bakery app.

At a terminal it asks for whatever you leave out: the directory, the ORM
(--orm/--no-orm) and the plugins (--plugins). Pass one and it stops asking
about that one; pass --yes and it stops asking entirely.

Arguments:
  [directory]       Where to create it. Also the package name, unless --name
                    is given. Use "." for the current directory.

Options:
  --name <name>     Package name, when it should differ from the directory.
  --orm             Include the ORM: orm/, db:sync, @bakery-framework/orm.
  --no-orm          Leave it out. The example API route keeps posts in memory.
  --plugins <list>  Comma-separated, from: ${PLUGIN_IDS.join(', ')}.
                    Use --plugins none for an explicit empty set.
  --yes, -y         Take the defaults for anything not passed: the directory
                    ${DEFAULT_FOLDER}, the ORM in, no plugins. Without a
                    terminal the ORM and plugins default the same way, and the
                    directory has to be given.
  --no-install      Write the files and stop, without running bun install.
  -h, --help        This.

Examples:
  bun create bakery
  bun create bakery my-app
  bun create bakery my-app --no-orm --plugins vue
  bun create bakery . --name my-app --plugins dashboard,analytics
  bun create bakery my-app --yes
`

/** What a package name may hold, for the messages that refuse one. */
const NAME_RULE =
  'Use lowercase letters, digits, dots, dashes and underscores, starting with a letter or a digit'

type Options = {
  /** As typed, or `null` when it was left out and is asked for. */
  dir: string | null
  /** `--name`, or `null` to take the directory's name. */
  name: string | null
  install: boolean
  /** `null` means "not specified". Ask, or fall back to the default. */
  orm: boolean | null
  plugins: PluginId[] | null
  yes: boolean
}

/**
 * Parse one `--plugins` value into the ids it names.
 *
 * Split out of `parseArgs` because it is the only flag that validates rather
 * than assigns, and inlining it put the loop over the complexity limit, which
 * is the rule doing its job: a `for` over argv should read as a dispatch table.
 */
function parsePlugins(
  value: string,
): { ok: true; plugins: PluginId[] } | { ok: false; message: string } {
  // `none` rather than an empty string, so "I want no plugins" is something you
  // can state: an empty `--plugins=` reads like a mistake and is treated as one
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: argv dispatcher, one branch per flag
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

  // Checked on its own, before any folder is known: no answer to the folder
  // question can repair a name typed on the command line.
  if (name !== null && !isValidAppName(name)) {
    return {
      ok: false,
      message: `"${name}" is not a usable package name. ${NAME_RULE}.`,
    }
  }

  // Left out, the directory is asked for once the flags are read (`chooseFolder`).
  if (dir === null) {
    return { ok: true, options: { dir, name, install, orm, plugins, yes } }
  }

  const target = resolveTarget(dir, name)
  if (!target.ok) {
    return {
      ok: false,
      message:
        `"${target.name}" is not a usable package name. ${NAME_RULE}, ` +
        'or pass --name to choose a different one.',
    }
  }

  return {
    ok: true,
    options: { ...target.target, install, orm, plugins, yes },
  }
}

/** Where the app goes, and the package name it is written with. */
export type Target = { dir: string; name: string }

/**
 * A directory argument, and `--name` if given, as the absolute directory and
 * the package name; or the name that cannot be one.
 */
export function resolveTarget(
  dirArg: string,
  nameArg: string | null,
): { ok: true; target: Target } | { ok: false; name: string } {
  // `.` is the documented way to scaffold in place, and `basename(resolve('.'))`
  // is the containing folder's name, which is the name the user means.
  const dir = resolve(dirArg)
  const name = nameArg ?? basename(dir)
  return isValidAppName(name)
    ? { ok: true, target: { dir, name } }
    : { ok: false, name }
}

/** How `chooseFolder` talks to the person running it. Swapped out by tests. */
export type FolderIO = {
  /** Ask for a line. `null` when there is no terminal to ask at. */
  ask: ((question: string, fallback: string) => Promise<string | null>) | null
  say: (line: string) => void
}

/**
 * The directory, when the command line left it out.
 *
 * Asked for at a terminal, and asked again until the answer is usable: a
 * folder whose name cannot be a package name, or one that already has files,
 * is explained and asked for again rather than ending the run, since the
 * person is right there to answer. `--yes` takes `DEFAULT_FOLDER` (or the
 * last part of `--name`). Without a terminal there is nobody to ask, and a
 * folder nobody named is not created: `'unasked'`.
 *
 * Returns `null` when the question was canceled.
 */
export async function chooseFolder(
  options: Pick<Options, 'name' | 'yes'>,
  io: FolderIO,
): Promise<Target | null | 'unasked'> {
  const fallback = options.name?.split('/').pop() ?? DEFAULT_FOLDER

  if (options.yes || !io.ask) {
    if (!options.yes) return 'unasked'
    const target = resolveTarget(fallback, options.name)
    if (!target.ok) return 'unasked'
    if (!(await isScaffoldable(target.target.dir))) {
      io.say(notEmpty(target.target.dir))
      return 'unasked'
    }
    return target.target
  }

  for (;;) {
    const answer = await io.ask('Folder name', fallback)
    if (answer === null) return null

    const target = resolveTarget(answer, options.name)
    if (!target.ok) {
      io.say(`"${target.name}" is not a usable package name. ${NAME_RULE}.`)
      continue
    }
    if (!(await isScaffoldable(target.target.dir))) {
      io.say(`${answer} already has files in it. Choose another folder.`)
      continue
    }
    return target.target
  }
}

/** Why a directory given on the command line, or by `--yes`, was refused. */
function notEmpty(dir: string): string {
  return (
    `${dir} already has files in it. Bakery will not scaffold over an ` +
    'existing directory. Pick an empty one, or empty this one first.'
  )
}

/**
 * Fill in whatever the flags left unspecified.
 *
 * Asks only when there is a terminal on both ends and `--yes` was not passed.
 * A pipe, a CI runner or a `--yes` takes the defaults (ORM in, no plugins),  * which is what `bun create bakery my-app` has always produced, so adding the
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
        { id: 'db-explorer', label: 'db-explorer', hint: 'browse and edit rows' },
      ])
      if (chosen === null) return null
      plugins = PLUGIN_IDS.filter(id => chosen.includes(id))
    }
  }

  // The explorer browses and edits whatever the ORM is connected to, so
  // scaffolding it without `orm/` produces an app whose headline feature has
  // nothing to show. Turned on rather than refused: the two are asked for
  // separately, and a generated app that boots is better than a prompt that
  // argues with the answer it was just given.
  if (!orm && plugins.some(id => PLUGINS_NEEDING_ORM.includes(id))) {
    orm = true
  }

  return { orm, plugins }
}

/**
 * True when `dir` does not exist, or exists and holds nothing that would be
 * overwritten.
 *
 * Scaffolding is the one operation where "the directory already had something
 * in it" is almost always a mistake, and it is not undoable, so this refuses
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
    // error also lands here and is caught properly by the write that follows:
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

  const { install } = parsed.options
  const interactive = !parsed.options.yes && isInteractive()

  // The directory comes first, and is checked before the other questions, not
  // after: asking someone three questions and then refusing because the
  // directory was never usable is the rudest possible ordering.
  let target: Target
  if (parsed.options.dir !== null && parsed.options.name !== null) {
    target = { dir: parsed.options.dir, name: parsed.options.name }
    if (!(await isScaffoldable(target.dir))) {
      console.log(notEmpty(target.dir))
      return 1
    }
  } else {
    const chosen = await chooseFolder(parsed.options, {
      ask: interactive ? text : null,
      say: line => console.log(line),
    })
    if (chosen === null) {
      console.log('\nCanceled. Nothing was written.')
      return 130
    }
    if (chosen === 'unasked') {
      if (!parsed.options.yes) {
        console.log(
          'Name the directory to create the app in: bun create bakery <directory>. ' +
            'At a terminal it asks for one instead.',
        )
      }
      return 1
    }
    target = chosen
  }
  const { dir, name } = target

  const choices = await resolveChoices(parsed.options)
  if (!choices) {
    console.log('\nCanceled. Nothing was written.')
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
    const run = (flags: string[]) =>
      Bun.spawn(['bun', 'install', ...flags], {
        cwd: dir,
        stdout: 'inherit',
        stderr: 'inherit',
      }).exited

    let code = await run([])
    // A release a few minutes old is on npm before Bun's cached package list
    // knows it, and the app asks for this scaffolder's own minor. On
    // 2026-10-04, `bun create bakery@latest` 2.1.2 wrote `^2.1.2` and the
    // install failed with "No version matching" until the cache was skipped.
    if (code !== 0) {
      console.log(
        "\nRetrying with Bun's package cache skipped, in case a release is minutes old.\n",
      )
      code = await run(['--no-cache'])
    }
    if (code !== 0) {
      console.log(
        '\nbun install failed. The app is written. Run it again in ' +
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
