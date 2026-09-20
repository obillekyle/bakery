#!/usr/bin/env bun

import '@bakery-framework/core/core/init'
// Safe as a static import: `core/port` reads `process.env` and imports nothing,
// so it cannot be the edge that closes core's barrel cycle.
import { applyPortFlag } from '@bakery-framework/core/core/port'
// Safe as a static import for the same reason as `core/port`: `args.ts` imports
// nothing at all.
import { parseThreadsOption } from './args'

const isDev = import.meta.env.DEV
const isDevWorker = import.meta.env.DEV_WORKER
const isThreadWorker = import.meta.env.THREAD_WORKER

const threadsOption = parseThreadsOption(process.argv.slice(2))

/**
 * `--help` before anything else, because everything else starts a server.
 *
 * There was no help branch at all: `bakery --help` fell through to `./prod`,
 * booted a production server, bound the configured port and sat there. On a
 * machine where that port is already taken it fails with a bind error, and on
 * one where it is free it silently *takes* it: either way the user asked what
 * the flags were and got a running service.
 *
 * Printed with `console.log` and not the structured logger, for the reason
 * CLAUDE.md records as one of the two standing exceptions: usage text is
 * program output, not a log line, and it goes to stdout so it can be piped.
 */
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage: bakery [--dev] [--sync] [--threads N] [--port N]

Runs the application in the current directory: the one whose
\`server.config.ts\` sits beside it.

Flags:
  --dev             Development: a supervisor that watches files, compiles on
                    demand and reloads the browser. Without it, production.
  --sync, -s        Run the schema sync before starting. Requires
                    @bakery-framework/orm; it is an error rather than a skip
                    when that is missing, because asking for a sync and
                    silently not doing one looks like it worked.
  --threads N, -t N Fork a cluster of N workers. Production only: ignored
                    under --dev. THREAD_ID 0 owns the startup banner.
  --port N, -p N    Listening port. Overrides \`port\` in server.config.ts and
                    the PORT environment variable.
  --help, -h        This.

Schema commands have their own help: \`bun run db:sync --help\`.
`)
  process.exit(0)
}

// Before any mode takes over, and before the config is read: `applyPortFlag`
// writes `process.env.PORT`, which is what the worker, the startup banner and
// the dev master's advertised URL all resolve from, and what the spawned dev
// worker and the cluster Workers inherit. Doing it here means none of them
// needed changing.
applyPortFlag()

if (
  (process.argv.includes('--sync') || process.argv.includes('-s')) &&
  // **Not in development, where `dev.ts` owns the decision.** Under `--dev`
  // this file is the watcher master, which then spawns a `--dev-worker` that
  // reaches `dev.ts`, and that path reads `--sync` as `force`, hashes the
  // schema sources, decides skip-or-run against the recorded hash and writes
  // the new one. Running here as well meant `--dev --sync` synced twice per
  // boot: once blindly in the master and once properly in the worker, against
  // the same database, with the master's pass doing work the worker was about
  // to redo. Production keeps this branch, because `prod.ts` does not sync at
  // all and this is the only thing that answers `--sync` there.
  !isDev &&
  !isDevWorker &&
  !isThreadWorker
) {
  // The one place absence is an *error* rather than a skip. Everywhere else the
  // ORM is missing because the app never wanted one; here the user typed
  // `--sync`, which is a request to sync a database, and quietly doing nothing
  // would look like it worked.
  const { hasORM, ORM_MISSING } = await import('./orm')
  if (!hasORM()) {
    const { serveLog } = await import('@bakery-framework/core/logger')
    serveLog.UNHANDLED_ERR({ error: `--sync: ${ORM_MISSING}` })
    process.exit(1)
  }
  const { SyncService } = await import('@bakery-framework/orm/sync')
  await SyncService.run()
}
try {
  if (threadsOption !== null && !isDevWorker && !isThreadWorker && !isDev) {
    const { handleThreadsMaster } = await import('./threads')
    await handleThreadsMaster(threadsOption)
  } else if (!isDev) {
    await import('./prod')
  } else if (isDevWorker || isThreadWorker) {
    await import('./dev')
  } else {
    await import('./watcher')
  }
} catch (error: any) {
  // Deliberately console.error and not the structured logger: this is the
  // last-resort handler around the very imports that load the logger, so
  // reaching for it here could throw and mask the original failure.
  console.error('Fatal unhandled error during startup:', error?.stack || error)
  process.exit(1)
}
