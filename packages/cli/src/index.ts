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

// Before any mode takes over, and before the config is read: `applyPortFlag`
// writes `process.env.PORT`, which is what the worker, the startup banner and
// the dev master's advertised URL all resolve from — and what the spawned dev
// worker and the cluster Workers inherit. Doing it here means none of them
// needed changing.
applyPortFlag()

if (
  (process.argv.includes('--sync') || process.argv.includes('-s')) &&
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
