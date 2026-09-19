import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Boot one of the repo's apps in **production** and request what it ships.
 *
 * Written as shared code on the day the second caller appeared rather than
 * deduplicated afterwards, because the alternative is two implementations of
 * one boot sequence that drift — and a drift here is invisible, since both
 * copies would still report green while testing different things.
 *
 * **Production, not `--dev`, and that is the whole point.** CLAUDE.md has
 * recorded since the workspace split that "booted meant the process started,
 * not that anything was served": every `.tsx` page in `apps/starter` answered
 * 500 for an unknown stretch while the suite and the typecheck stayed green.
 * Four more defects of that exact shape have been found since, all of them
 * production-only, none of them visible to any gate that did not request a
 * page.
 *
 * Ports are passed in and none of them is 3000, which belongs to something
 * else on the maintainer's machine.
 */
const CLI = resolve(import.meta.dir, '../../packages/cli/src/index.ts')

export interface AppServer {
  base: string
  stop(): void
}

/**
 * Booted with `--sync`, which is the framework's own flag for "create the
 * schema before serving".
 *
 * Without it these tests depend on a database somebody happened to leave
 * behind. `apps/<app>/bakery/` is gitignored, so CI starts with none at all — and
 * production does not sync (only the dev worker does), which is how
 * `apps/starter` reached today answering 500 on `/api/notes` with `no such
 * table: posts` while every gate stayed green. The example app looked fine
 * only because a local database from past dev runs had the tables in it.
 *
 * A test that passes because of a leftover file is not testing the app.
 */
export async function bootApp(
  appDir: string,
  port: number,
): Promise<AppServer> {
  const base = `http://127.0.0.1:${port}`

  // Refuse a port something is already on, rather than testing against it.
  //
  // Without this the boot loop below cannot tell "my server came up" from
  // "somebody else's was already there": it polls until *anything* answers and
  // returns. A run killed part-way leaves a listener behind, and the next run
  // would then pass green against a server built from the previous tree, with
  // its own `.cache/` and its own schema. That is the whole "measure the thing
  // you think you are measuring" failure, in the one place where getting it
  // wrong makes every assertion downstream meaningless.
  const squatter = await fetch(base)
    .then(() => true)
    .catch(() => false)
  if (squatter) {
    throw new Error(
      `${port} is already in use; this test would have passed against a server it did not start`,
    )
  }

  const server = Bun.spawn(['bun', CLI, '--sync'], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port) },
    stdout: 'ignore',
    stderr: 'ignore',
  })

  const deadline = Date.now() + 60_000
  for (;;) {
    // A boot that failed is not a boot that is slow. Without this the process
    // could exit on a port clash or a schema error and the loop would spend
    // the whole 60 s waiting for a server that is never coming, then report a
    // timeout rather than the thing that actually happened.
    if (server.exitCode !== null) {
      throw new Error(`${appDir} exited with ${server.exitCode} before serving`)
    }
    if (Date.now() > deadline) {
      server.kill()
      throw new Error(`${appDir} never answered on ${port}`)
    }
    try {
      await fetch(base)
      return { base, stop: () => server.kill() }
    } catch {
      // Not listening yet. A connection refusal here is the ordinary state
      // during boot, which is why it is the one swallowed exception.
      await Bun.sleep(250)
    }
  }
}

/**
 * Route files, mapped to a URL by the documented rules.
 *
 * Deliberately naive about dynamic segments: a catch-all gets a deep path and
 * a single parameter gets `42`, because the question being asked is "does this
 * route answer at all", not "does it answer correctly for this input".
 */
export function discoverRoutes(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...discoverRoutes(full, `${prefix}/${entry}`))
      continue
    }
    const m = entry.match(/^(.*)\.(tsx|jsx|ts|css)$/)
    if (!m) continue
    const [, stem, ext] = m as unknown as [string, string, string]

    if (ext === 'css') {
      out.push(`${prefix}/${entry}`)
      continue
    }
    if (stem === 'index') out.push(prefix || '/')
    else if (stem.startsWith('[...')) out.push(`${prefix}/deep/nested/path`)
    else if (stem.startsWith('[')) out.push(`${prefix}/42`)
    else out.push(`${prefix}/${stem}`)
  }
  return out
}

/**
 * Every route that answered 5xx, with its status.
 *
 * **"Nothing 5xx", not "everything 200".** A route this walk maps badly is a
 * 404, and a 404 is a correct answer to a request for something that is not
 * there. Pairing this with a short list of routes that must be 200 is what
 * stops it passing on an app that 404s uniformly.
 */
export async function serverErrors(
  base: string,
  routes: string[],
): Promise<string[]> {
  const failures: string[] = []
  for (const route of routes) {
    const res = await fetch(base + route)
    await res.arrayBuffer()
    if (res.status >= 500) failures.push(`${route} -> ${res.status}`)
  }
  return failures
}
