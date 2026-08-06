#!/usr/bin/env bun

import '@bakery/core/core/init'

const isDev = import.meta.env.DEV
const isDevWorker = import.meta.env.DEV_WORKER
const isThreadWorker = import.meta.env.THREAD_WORKER

function getThreadsOption(): number | null {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--threads' || arg === '-t') {
      const next = args[i + 1]
      if (next && /^\d+$/.test(next)) {
        return Math.max(1, parseInt(next, 10))
      }
      return Math.min(Math.max(1, navigator.hardwareConcurrency || 4), 8)
    }
    if (arg.startsWith('--threads=') || arg.startsWith('-t=')) {
      const val = arg.split('=')[1]
      if (val && /^\d+$/.test(val)) {
        return Math.max(1, parseInt(val, 10))
      }
      return Math.min(Math.max(1, navigator.hardwareConcurrency || 4), 8)
    }
  }
  return null
}

const threadsOption = getThreadsOption()

if (
  (process.argv.includes('--sync') || process.argv.includes('-s')) &&
  !isDevWorker &&
  !isThreadWorker
) {
  const { SyncService } = await import('@bakery/orm/sync')
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
