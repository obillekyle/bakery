/**
 * The Relations view: what this table points at, and what points back.
 *
 * `GET /api/_db/graph` has always returned every declared foreign key. The grid
 * used it to turn a cell into a link, which is the per-row question; nobody
 * could see the *table's* shape without clicking through a row that happened to
 * have the reference filled in. Both directions are listed here, and both are
 * clickable, because "which tables reference this one" is the question you ask
 * before deleting anything.
 *
 * `relationsFor` is **pure** and does the grouping; the render half only turns
 * it into buttons.
 */

import type { Filter } from '../shared/filters'
import { box, button, each, el } from './dom'
import { equalityFilters } from './filter-builder'
import { reverseFks } from './fk'
import type { ForeignKeyInfo, SchemaGraph } from './meta'
import { sameTable } from './meta'

export interface Relation {
  /** The columns on the near side — this table's, for `outgoing`. */
  cols: string[]
  /** The table at the other end. */
  table: string
  /** The columns at the other end. */
  refCols: string[]
  name?: string
}

export interface Relations {
  /** Foreign keys declared *on* this table. */
  outgoing: Relation[]
  /** Foreign keys on other tables that point *at* this one. */
  incoming: Relation[]
}

/**
 * Both directions, grouped.
 *
 * `sameTable` rather than `===` throughout, and that is not defensive
 * programming: `getForeignKeys()` reports whatever the database calls a table
 * while `getConstraints()` is camel-keyed, and the graph endpoint passes both
 * through untouched. Comparing literally makes every foreign key on a
 * `snake_case` schema invisible — the whole feature silently absent, which is
 * exactly what `meta.ts`'s own note on `sameTable` records.
 *
 * A self-reference — a `manager_id` pointing at the same table's `id` — appears
 * in **both** lists, which is correct: it is genuinely a key this table
 * declares and genuinely a key that points here.
 */
export function relationsFor(
  graph: SchemaGraph | null,
  table: string,
): Relations {
  if (!graph) return { outgoing: [], incoming: [] }

  const outgoing = Object.values(graph.foreignKeys)
    .filter(fk => sameTable(fk.table, table))
    .map(toOutgoing)
  const incoming = reverseFks(graph, table).map(toIncoming)
  return { outgoing, incoming }
}

function toOutgoing(fk: ForeignKeyInfo): Relation {
  return {
    cols: fk.cols,
    table: fk.refTable,
    refCols: fk.refCols,
    name: fk.name,
  }
}

/**
 * An incoming key, read from the far side.
 *
 * `cols` are the *referencing* table's columns and `refCols` are ours, which is
 * the reverse of the outgoing shape and is what makes the two lists read the
 * same way on screen: near columns first, far table second.
 */
function toIncoming(fk: ForeignKeyInfo): Relation {
  return {
    cols: fk.cols,
    table: fk.table,
    refCols: fk.refCols,
    name: fk.name,
  }
}

// --------------------------------------------------------------------- render

export interface RelationsContext {
  table: string
  graph: SchemaGraph | null
  /** Open a table in a tab, optionally filtered. */
  onOpen: (table: string, filters: Filter[]) => void
}

export function renderRelations(ctx: RelationsContext): HTMLElement {
  const relations = relationsFor(ctx.graph, ctx.table)
  const node = box('relations')

  node.appendChild(
    section(
      `References (${relations.outgoing.length})`,
      'columns of this table that point elsewhere',
      relations.outgoing,
      relation => outgoingRow(ctx, relation),
    ),
  )
  node.appendChild(
    section(
      `Referenced by (${relations.incoming.length})`,
      'tables whose rows point at this one',
      relations.incoming,
      relation => incomingRow(ctx, relation),
    ),
  )
  return node
}

function section(
  title: string,
  blurb: string,
  relations: readonly Relation[],
  make: (relation: Relation) => HTMLElement,
): HTMLElement {
  const node = box('structure-section')
  node.appendChild(el('h3', { text: title }))
  node.appendChild(el('p', { class: 'note', text: blurb }))
  if (!relations.length) {
    node.appendChild(el('p', { class: 'note', text: 'none declared' }))
    return node
  }
  const list = box('relation-list')
  each(list, relations, make)
  node.appendChild(list)
  return node
}

/**
 * `this.col → that.col`, opening the referenced table unfiltered.
 *
 * Unfiltered on purpose: an outgoing key is a statement about the *schema*, not
 * about a row. Which row it points at depends on which row you are looking at,
 * and that link is the one in the grid cell.
 */
function outgoingRow(ctx: RelationsContext, relation: Relation): HTMLElement {
  const row = box('relation')
  row.appendChild(
    el('span', {
      class: 'relation-cols',
      text: `${relation.cols.join(', ')} →`,
    }),
  )
  row.appendChild(
    button(
      `${relation.table}.${relation.refCols.join(', ')}`,
      () => ctx.onOpen(relation.table, []),
      { class: 'btn', title: `open ${relation.table}` },
    ),
  )
  if (relation.name) {
    row.appendChild(el('span', { class: 'note', text: relation.name }))
  }
  return row
}

function incomingRow(ctx: RelationsContext, relation: Relation): HTMLElement {
  const row = box('relation')
  row.appendChild(
    button(
      `${relation.table}.${relation.cols.join(', ')}`,
      () => ctx.onOpen(relation.table, []),
      { class: 'btn', title: `open ${relation.table}` },
    ),
  )
  row.appendChild(
    el('span', {
      class: 'relation-cols',
      text: `→ ${relation.refCols.join(', ')}`,
    }),
  )
  return row
}

/**
 * The filters that open the rows of `relation.table` pointing at one row.
 *
 * Exported for the row panel, which is where "referenced by *this row*" lives.
 * `eq` per column, so the count and the page are exact — this used to be a
 * substring `LIKE` and the panel had to label its counts "approximate".
 */
export function filtersForIncoming(
  relation: Relation,
  row: Record<string, unknown>,
): Filter[] {
  const key: Record<string, unknown> = {}
  relation.refCols.forEach((refCol, index) => {
    const column = relation.cols[index]
    if (column) key[column] = row[refCol]
  })
  return equalityFilters(key)
}
