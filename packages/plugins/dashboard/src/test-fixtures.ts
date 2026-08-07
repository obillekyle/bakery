/**
 * Fixtures shared by this plugin's test files.
 *
 * Deliberately not named `*.test.ts`: nothing here runs on its own, and Bun
 * would collect it as an empty suite.
 */

/**
 * A database stand-in that records what it was asked to do and does none of it.
 *
 * The assertion that matters in both suites is that the recorded list stays
 * *empty* — a rejection that arrives after the truncate is not a rejection — so
 * the stub must reach no real database and must log every method the endpoints
 * can call. `setup.test.ts` (routing and CSRF) and `endpoints/database.test.ts`
 * (the write gate) each kept their own copy, and the copies had already
 * diverged: one was missing `insert` and `query` entirely.
 *
 * A factory rather than a shared singleton. Bun loads every test file into one
 * process, so a module-level array would be shared state between two suites
 * that reset it on different hooks; each caller gets its own.
 */
export function createStubDb() {
  const calls: string[] = []

  const db = {
    truncate: async (table: string) => {
      calls.push(`truncate:${table}`)
    },
    remove: async (table: string, rowid: unknown) => {
      calls.push(`remove:${table}:${rowid}`)
    },
    insert: async (table: string) => {
      calls.push(`insert:${table}`)
    },
    query: (sql: string) => ({
      all: async () => {
        calls.push(`all:${sql}`)
        return []
      },
      run: async () => {
        calls.push(`run:${sql}`)
        return { lastInsertRowid: 1, changes: 1 }
      },
    }),
  }

  return {
    db,
    calls,
    /** Emptied in place, so the array identity a suite captured stays valid. */
    reset: () => {
      calls.length = 0
    },
  }
}
