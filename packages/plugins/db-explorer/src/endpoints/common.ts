/**
 * The preamble every write endpoint shares, in the order the checks have to
 * happen.
 *
 *   1. **`currentCanWrite()`** — a `read` caller is refused before the body is
 *      even parsed, so nothing about the request can influence the answer.
 *   2. **The body** — JSON, an object, naming a table.
 *   3. **The table** — 404 if it is not there.
 *   4. **The identity** — 409 if the table has none. A table with no primary
 *      key and no all-NOT-NULL unique index is read-only for everyone,
 *      including a `write` caller, because there is no way to name one of its
 *      rows. See `identity.ts`.
 *
 * Bounds (413) and validation (400) come after, in each endpoint, because they
 * are about the request's own shape rather than about who is asking.
 */

import { errorMsg, pluginLog } from '@bakery-framework/core/logger'
import { Case, Try } from '@bakery-framework/core/utils'
import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import { currentCanWrite } from '../access'
import { introspect, type TableFacts } from '../identity'
import type { FieldError } from '../validate'

export type Envelope = JsonResponseData<unknown>

export type WriteStart =
  | { ok: true; table: TableFacts; body: Record<string, unknown> }
  | { ok: false; response: Envelope }

/** A 400 carrying every field error, never only the first. */
export function invalid(errors: FieldError[]): Envelope {
  return response.json.error(400, 'Invalid request', { errors })
}

/**
 * The request body as an object, or `null`.
 *
 * `req.json()` rather than core's `processBody`, which answers `{}` for a body
 * it could not parse — indistinguishable from an empty one, so a truncated
 * upload would be reported as a missing `table` field.
 */
export async function readBody(
  req: Request,
): Promise<Record<string, unknown> | null> {
  const body = await Try.return(
    async () => (await req.json()) as unknown,
    null as unknown,
  )
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/**
 * Find a table by the name the caller used.
 *
 * Raw database name first — that is what `/api/_db/schema` renders and what the
 * grid sends back. The camel spelling is accepted as well, because a script
 * written against a typed schema has `orderItems` where the database has
 * `order_items`, and refusing that would be refusing the ORM's own vocabulary.
 */
export function findTable(
  tables: Map<string, TableFacts>,
  name: string,
): TableFacts | undefined {
  const exact = tables.get(name)
  if (exact) return exact
  const camel = Case.camel(name)
  for (const table of tables.values()) {
    if (table.camel === camel) return table
  }
  return undefined
}

export async function beginWrite(req: Request): Promise<WriteStart> {
  // First, and before the body is read. Convention 2: the guard returns the
  // rejection, and it is the caller's job to return it unchanged.
  if (!currentCanWrite()) {
    return {
      ok: false,
      response: response.json.error(403, 'This session may read but not write'),
    }
  }

  const body = await readBody(req)
  if (!body) {
    return {
      ok: false,
      response: response.json.error(400, 'Expected a JSON object body'),
    }
  }

  const name = body.table
  if (typeof name !== 'string' || !name) {
    return {
      ok: false,
      response: response.json.error(400, 'table is required'),
    }
  }

  const tables = await introspect()
  const table = findTable(tables, name)
  if (!table) {
    return {
      ok: false,
      response: response.json.error(404, `No table named ${name}`),
    }
  }

  if (table.identity.mode === 'none') {
    return {
      ok: false,
      response: response.json.error(
        409,
        `${table.name} is read-only: ${table.identity.reason}`,
      ),
    }
  }

  return { ok: true, table, body }
}

/**
 * Refuse a request without telling the caller what the database said.
 *
 * Every read endpoint used to answer `400` with `error.message` verbatim, so a
 * malformed `page` came back as SQLite's "datatype mismatch" and a bad lookup
 * key as a JavaScript `TypeError` naming an internal expression. Postgres is
 * worse: its parse errors quote the statement. A caller holding only `read`
 * cannot be handed the query text, and none of it helps a client that has
 * already been told its request was invalid.
 *
 * The message still exists — it goes to the server log with the operation that
 * produced it, which is where an operator can act on it.
 */
export function refuse(op: string, error: unknown, status = 400): Envelope {
  pluginLog.EXPLORER_QUERY_ERR({ op, error: errorMsg(error) })
  return response.json.error(status, `${op} failed`)
}
