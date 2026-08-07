#!/usr/bin/env bun

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
  dependencyRange,
  isValidAppName,
  templateFiles,
  type TemplateFile,
} from './template'

/**
 * `bun create bakery <dir>`.
 *
 * `bun create x` fetches `create-x` and runs its bin with the remaining
 * arguments, which is the whole reason this is a separate unscoped package
 * rather than another verb on the `bakery` bin: `@bakery/cli` owns that bin,
 * and it is a dependency of the app you are trying to create.
 *
 * Deliberately dependency-free. `bun create` downloads this package on its own,
 * so anything it depends on is a download the user waits through before seeing
 * a single file — and the framework it scaffolds is the last thing it should
 * drag along.
 */

const HELP = `bun create bakery <directory>

Scaffold a Bakery app.

Arguments:
  <directory>       Where to create it. Also the package name, unless --name
                    is given. Use "." for the current directory.

Options:
  --name <name>     Package name, when it should differ from the directory.
  --no-install      Write the files and stop, without running bun install.
  -h, --help        This.

Examples:
  bun create bakery my-app
  bun create bakery . --name my-app
`

type Options = {
  dir: string
  name: string
  install: boolean
}

/**
 * Parse argv into options, or return a message to print and exit on.
 *
 * Returns rather than throws for a *usage* problem: a bad flag is a thing the
 * user typed, and answering it with a stack trace teaches nothing. Throwing is
 * reserved for a failure of the scaffolding itself.
 */
export function parseArgs(
  argv: string[],
): { ok: true; options: Options } | { ok: false; message: string } {
  let dir: string | null = null
  let name: string | null = null
  let install = true

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '-h' || arg === '--help') return { ok: false, message: HELP }

    if (arg === '--no-install') {
      install = false
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

  return { ok: true, options: { dir: resolved, name: appName, install } }
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

/** This package's own version, which the generated dependency range follows. */
async function ownVersion(): Promise<string> {
  const pkg = await Bun.file(
    new URL('../package.json', import.meta.url),
  ).json()
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

  if (!(await isScaffoldable(dir))) {
    console.log(
      `${dir} already has files in it. Bakery will not scaffold over an ` +
        'existing directory — pick an empty one, or empty this one first.',
    )
    return 1
  }

  const files = templateFiles(name, dependencyRange(await ownVersion()))
  await writeTemplate(dir, files)

  console.log(`Created ${name} in ${dir}`)

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
      '  bun run db:sync\n  bun run dev\n',
  )

  return 0
}

if (import.meta.main) process.exit(await main())
