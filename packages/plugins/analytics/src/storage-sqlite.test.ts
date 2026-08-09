import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { type LoggerEntry, setLogCallback } from '@bakery-framework/core/logger'
import { __resetTestDb, __setTestDb, saveAnalyticsData } from './storage-sqlite'

/** Collect log lines for the duration of one call. */
async function capture(fn: () => Promise<void>): Promise<LoggerEntry[]> {
  const entries: LoggerEntry[] = []
  setLogCallback(entry => void entries.push(entry))
  try {
    await fn()
  } finally {
    setLogCallback(() => {})
  }
  return entries
}

afterEach(() => {
  __resetTestDb()
})

describe('saveAnalyticsData failure reporting', () => {
  test('a flush that throws is logged, not swallowed', async () => {
    // A closed handle is the shape the real failure took: shutdown closed the
    // shared cache DB before this hook ran, every statement here threw, and
    // the outer `catch {}` reported nothing. On the shutdown path there is no
    // "next flush" to retry, so the write was simply lost.
    const closed = new Database(':memory:')
    closed.close()
    __setTestDb(closed)

    const entries = await capture(() => saveAnalyticsData(''))

    const failure = entries.find(entry =>
      entry.msg.includes('Analytics flush failed'),
    )

    expect(failure).toBeDefined()
    expect(failure!.level).toBe('error')
    expect(failure!.by).toBe('analytics')
  })

  test('a flush that throws still does not take down its caller', async () => {
    // The half of the old behaviour that was correct: telemetry must never be
    // able to kill what it is measuring.
    const closed = new Database(':memory:')
    closed.close()
    __setTestDb(closed)

    expect(await saveAnalyticsData('')).toBeUndefined()
  })

  test('a healthy flush logs nothing', async () => {
    __setTestDb(new Database(':memory:'))

    const entries = await capture(() => saveAnalyticsData(''))

    expect(
      entries.filter(entry => entry.msg.includes('Analytics flush failed')),
    ).toEqual([])
  })
})
