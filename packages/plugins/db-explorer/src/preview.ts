/**
 * Rolling a transaction back on purpose, and getting an answer out of it.
 *
 * **This is a workaround for a gap in the ORM, and it should be read as one.**
 * `SQLAdapter.transaction()` commits when the callback returns and rolls back
 * when it throws — there is no third outcome, so there is no way to say "undo
 * this, and here is what it would have done". A dry run needs exactly that: the
 * statements have to actually execute (otherwise the report is a guess about
 * constraints the database has not been asked about), and then not stick.
 *
 * So the report rides out on the exception. The transaction rolls back because
 * the callback threw, `Try.return` catches the signal outside and turns it into
 * an ordinary response, and anything that is **not** this class is rethrown —
 * which is the part that has to stay right. A `catch` that swallowed a real
 * error here would report a failed write as a successful preview.
 *
 * The honest fix is a `transaction()` that takes a rollback decision from its
 * callback's return value. When the ORM grows one, this module goes away and
 * the four endpoints that import it lose an `if`.
 */

/**
 * A deliberate rollback carrying its report.
 *
 * `status` because two different outcomes need the same mechanism: a dry run
 * answers 200 with what *would* have happened, and a bulk edit that hit an
 * optimistic-concurrency conflict answers 409 with what did — and both have to
 * leave the database untouched, so both have to leave through a throw.
 */
export class RollbackSignal<T = unknown> extends Error {
  constructor(
    readonly report: T,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RollbackSignal'
  }
}

/** A dry run: nothing kept, 200 with the report. */
export function previewRollback<T>(report: T): never {
  throw new RollbackSignal(report, 200, 'dry run — rolled back')
}

/** A conflict: nothing kept, 409 with the report. */
export function conflictRollback<T>(report: T): never {
  throw new RollbackSignal(report, 409, 'conflict — rolled back')
}

export function isRollbackSignal(error: unknown): error is RollbackSignal {
  return error instanceof RollbackSignal
}
