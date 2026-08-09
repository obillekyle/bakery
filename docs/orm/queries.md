# Queries

`DB` is the query builder. It is the default export of `@bakery/orm` and also a
named one:

```ts
import DB from '@bakery/orm'

const users = await DB.from('users').array()
```

Every method returns the builder, and nothing runs until you call an execution
method. `DB.table` and `DB.from` are the same function.

## Columns are dotted strings

A column is written `'table.column'`, or bare when it is unambiguous:

```ts
import DB from '@bakery/orm'

const q = DB.from('posts').select({ title: 'posts.title', id: 'posts.id' })
```

Not an object, not a builder call — a string. Both halves are validated against
an identifier pattern and quoted for the active dialect, and they are
snake-cased on the way out, so `'posts.createdAt'` emits `"posts"."created_at"`.

Rows come back with both spellings: the driver's key plus a camelCase alias. A
`subject_code` column is readable as `row.subject_code` and `row.subjectCode`.

## `.where()` takes two arguments

**This is the single most important thing on this page.**

```ts
import DB from '@bakery/orm'

// column, value — the operator defaults to `=`
const q = DB.from('users').where('users.id', 42)
```

There is no three-argument form. The signature is
`where(column, valueOrRef?)`, and `parseWhereArgs` defaults the operator to `=`
([`orm/query.ts`](../../packages/orm/src/orm/query.ts)).

If you write the SQL-looking version out of habit:

```ts no-check — deliberately wrong; kept out of the compile because it is the bug being described
DB.from('users').where('users.id', '=', 42)
```

…then `'='` becomes **the value** and the `42` is dropped. The emitted predicate
is `WHERE "users"."id" = ?` bound to the string `'='`. Valid SQL, wrong
question, zero rows, no error at any layer.

`tsc` does catch it — *Expected 1-2 arguments, but got 3* — but Bun strips types
without checking them, so `bun run dev` runs it happily. If you never run
`bun run typecheck`, nothing tells you. That is how this survived ~25 times in
the documentation these pages replace. Anything comparing against a literal
`'='` in your data is a symptom.

Use an operator helper when you need something other than equality.

## Operators

Helpers live on `DB` and go in the second position:

```ts
import DB from '@bakery/orm'

const q = DB.from('students')
  .where('students.year', DB.gte(2))
  .and('students.course', DB.inList(['BSCS', 'BSIT']))
  .and('students.id', DB.between(10, 50))
  .and('students.nickname', DB.isNotNull())
```

emits

```sql
SELECT * FROM "students"
WHERE "students"."year" >= ?
  AND "students"."course" IN (?, ?)
  AND "students"."id" BETWEEN ? AND ?
  AND "students"."nickname" IS NOT NULL
```

| Helper | SQL | Notes |
| --- | --- | --- |
| `DB.equals(v)` / `DB.eq(v)` | `=` | the implicit default |
| `DB.notEquals(v)` / `DB.neq(v)` | `<>` | |
| `DB.gt(v)` `DB.gte(v)` `DB.lt(v)` `DB.lte(v)` | `>` `>=` `<` `<=` | |
| `DB.like(v)` | `LIKE` | you supply the `%` |
| `DB.ilike(v)` | `ILIKE` | Postgres only |
| `DB.inList(v)` / `DB.in(v)` | `IN` | array or subquery |
| `DB.notInList(v)` / `DB.notIn(v)` | `NOT IN` | |
| `DB.isNull()` / `DB.isNotNull()` | `IS [NOT] NULL` | no argument |
| `DB.between(a, b)` | `BETWEEN … AND …` | |

Values always bind as parameters; identifiers are validated, quoted and
interpolated. Nothing crosses from one category to the other.

## Comparing two columns

A bare string in the value position is a *value*, not a column — that is what
keeps user input from becoming SQL. Wrap a column reference in `DB.col()` when
you mean the other thing:

```ts
import DB from '@bakery/orm'

const q = DB.from('users')
  .where('users.shippingAddress', DB.col('users.billingAddress'))
```

`DB.cols` is an alias of `DB.col`. Both compose with the operator helpers:
`DB.gt(DB.col('users.updatedAt'))`.

## Combining conditions

`.and()` and `.or()` take the same two arguments as `.where()`. They append in
call order and are not grouped — there is no parenthesised builder API. Use
`DB.raw` if you need explicit grouping.

```ts
import DB from '@bakery/orm'

const q = DB.from('users')
  .where('users.status', 'active')
  .and('users.role', DB.inList(['admin', 'editor']))
  .or('users.id', 1)
```

## Projection

`.select({ alias: column })` names every output column. `.selectAll(alias?)`
emits `alias.*`.

```ts
import DB from '@bakery/orm'

const q = DB.from('teachers').select({
  teacherId: 'teachers.id',
  fullName: 'teachers.surname',
})
// SELECT "teachers"."id" AS "teacherId", "teachers"."surname" AS "fullName" …
```

Clauses are assembled and only emitted by `parse()`, so call order does not
matter: `.select(…).where(…)` and `.where(…).select(…)` produce identical SQL.

## Aggregates and functions

```ts
import DB from '@bakery/orm'

const q = DB.from('campuses')
  .leftJoin('campuses.id', 'teachers.campusId', 't')
  .groupBy('campuses.id')
  .select({
    id: 'campuses.id',
    facultyCount: DB.count('t.id'),
    newest: DB.max('t.createdAt'),
  })
```

Available: `count`, `sum`, `avg`, `min`, `max`, `lower`, `upper`, `length`,
`coalesce`, `abs`, `concat`. The function *name* is interpolated rather than
bound, so it is checked against a fixed allow-list; anything else throws
`Unsupported SQL function`
([`schema-util.ts`](../../packages/orm/src/schema-util.ts)). `DB.count('*')`
is supported; the rest expect a column.

## Joins

`join(leftColumn, rightColumn, alias?, type?)`, plus `leftJoin`, `rightJoin`,
`innerJoin` and `fullJoin`. The `ON` clause is always an equality between the
two columns.

```ts
import DB from '@bakery/orm'

const q = DB.from('campuses')
  .leftJoin('campuses.id', 'teachers.campusId', 't')
  .select({ campusId: 'campuses.id', teacher: 't.surname' })
// … LEFT JOIN "teachers" AS "t" ON "campuses"."id" = "t"."campus_id"
```

Pass a **dotted** right-hand column. The type requires it — `rightCol` is
typed `\`${string}.${string}\`` — so an undotted argument is a compile error, and
it now resolves to that table's `id` rather than emitting a malformed `ON`
clause if you reach the runtime path from JavaScript.

The alias becomes the name every later column qualifies against, and the
unaliased table name drops out of scope — after `as 't'`, write `'t.surname'`,
not `'teachers.surname'`.

To join a table to itself, alias it. To do the same in a *schema* declaration,
see `alias()` in [Schema](schema.md).

`fullJoin` needs a caveat: **MySQL has no `FULL OUTER JOIN`**, at any version.
SQLite (3.39+) and Postgres do. Calling it on MySQL throws at the call site
rather than emitting SQL the server rejects, because MySQL's own message for it
is "You have an error in your SQL syntax" pointing at the whole statement. The
standard workaround is a `LEFT JOIN` unioned with a `RIGHT JOIN`, which is a
different query rather than a flag — so the builder does not rewrite it for you.

## Set operations

`union`, `unionAll`, `intersect` and `except` combine two queries. They return a
**set**, not a query:

```ts
import DB from '@bakery/orm'

const everyone = DB.from('students')
  .select({ name: 'students.surname' })
  .union(DB.from('teachers').select({ name: 'teachers.surname' }))
  .orderBy('name')
  .limit(50)
```

What comes back has `orderBy`, `limit`, `offset` and `paginate` — what SQL
allows after the last operand — and nothing else. `where` and `select` are gone
because they would have to mean "on which branch?"; put them on the branch.

Chaining a third operand extends the set rather than nesting it, matching SQL's
own left-to-right evaluation:

```ts
import DB from '@bakery/orm'

const q = DB.from('a').union(DB.from('b')).except(DB.from('c'))
// SELECT * FROM "a" UNION SELECT * FROM "b" EXCEPT SELECT * FROM "c"
```

Two things the dialects disagree about, both handled for you:

- **A branch with its own `ORDER BY` or `LIMIT`** cannot sit bare in a compound.
  Parenthesising it is the documented fix and works on MySQL and Postgres —
  *SQLite rejects a parenthesised operand outright*. So the builder wraps that
  branch as a derived table instead, which all three accept.
- **`INTERSECT ALL` and `EXCEPT ALL`** (pass `true` as the second argument)
  exist on MySQL 8.0.31+ and Postgres. SQLite has neither, and reports
  `near "ALL": syntax error`. The builder refuses by name instead, and points at
  the plain form. `UNION ALL` is universal and is never gated.

## Window functions

`DB.over()` puts an `OVER (…)` clause on any aggregate the builder already has:

```ts
import DB from '@bakery/orm'

const q = DB.from('students').select({
  year: 'students.year',
  runningTotal: DB.over(DB.sum('students.year'), {
    partitionBy: 'students.course',
    orderBy: 'students.year',
  }),
})
```

`DB.rowNumber()`, `DB.rank()` and `DB.denseRank()` take only the window — the
window *is* their argument:

```ts
import DB from '@bakery/orm'

const q = DB.from('students').select({
  name: 'students.surname',
  place: DB.rank({ partitionBy: 'students.course', orderBy: 'students.year DESC' }),
})
```

The direction goes inside the `orderBy` string, per column, so two columns can
disagree: `orderBy: ['students.year DESC', 'students.surname']`. Anything else
in the window vocabulary goes through `DB.window(name, args, spec)`:

```ts
import DB from '@bakery/orm'

const q = DB.from('orders').select({
  previous: DB.window('LAG', [DB.col('orders.total'), 1], {
    orderBy: 'orders.createdAt',
  }),
})
```

Arguments follow the same rule as everywhere else in the builder: a bare value
binds as a parameter, `DB.col(…)` references a column. The function name is
checked against an allow-list — it is interpolated, not bound.

Window functions work on all three dialects (SQLite 3.25+, MySQL 8.0+,
Postgres). Frame clauses (`ROWS BETWEEN …`) are **not** offered; every call gets
SQL's default frame.

## Grouping

```ts
import DB from '@bakery/orm'

const q = DB.from('students')
  .groupBy('students.course')
  .select({ total: DB.sum('students.year') })
  .having(DB.sum('students.year'), DB.gt(1000))
```

`having` takes the same two arguments as `where`, and chains with `andHaving` /
`orHaving`.

## Ordering and paging

```ts
import DB from '@bakery/orm'

const page = DB.from('products')
  .selectAll()
  .orderBy('category', 'ASC')
  .orderBy('price', 'DESC')
  .paginate(2, 20) // LIMIT 20 OFFSET 20
```

`limit(count, offset?)` is the explicit form. All three are legal straight off a
table — no `where` or `select` needed first.

`LIMIT`, `OFFSET` and the sort direction are interpolated, not bound, so both
are validated at the call site: a direction other than `ASC`/`DESC` throws
`Invalid sort direction`, and a non-numeric or negative limit throws
`Invalid limit`. Numeric strings are coerced. **Never pass a raw request value
as a column name or a direction** — the `'ASC' | 'DESC'` union is erased at
runtime, and the column allow-list is the only thing standing between a query
string and your SQL.

### Cursor paging with `seek()`

`paginate()` uses `OFFSET`, and an offset is not free: `LIMIT 20 OFFSET 200000`
makes the server walk and discard 200,000 rows, so page 10,000 costs far more
than page 1. Past a few hundred thousand rows, `seek()` is the answer:

```ts
import DB from '@bakery/orm'

const first = await DB.from('posts').selectAll().seek('id', null, 20).array()
const next = await DB.from('posts')
  .selectAll()
  .seek('id', first.at(-1)!.id, 20)
  .array()
```

`null` (or `undefined`) means the first page, so one call site handles both
without a branch. `seek()` sets the ordering itself — a cursor is a position in
an order — and prepends it, so an explicit `orderBy()` still breaks ties after
it. Pass `'DESC'` as the fourth argument to walk backwards.

It also does not skip or repeat rows when the table is written to mid-scan,
which offset paging does by construction: delete one row from page 1 and every
later page shifts by one, so a row is never seen.

The trade-offs are real, and both are consequences of how it works rather than
gaps to be filled later. Pages are reachable **only in order** — there is no
"jump to page 500" — and the cursor column must be **unique and ordered**, in
practice a primary key or something monotonic. A non-unique column silently
drops rows that tie on the boundary value, which is why `seek()` takes one
column rather than appearing to sort by several.

## Relations: there aren't any, on purpose

Bakery's ORM has no `hasMany`, no `include`, no eager loading. That is a
decision, not a missing feature, and it is worth stating plainly so you can
judge whether it suits you rather than waiting for something that is not
coming.

Write the join:

```ts
import DB from '@bakery/orm'

const rows = await DB.from('posts')
  .join('posts.authorId', 'users.id')
  .select({ title: 'posts.title', author: 'users.name' })
  .array()
```

The reasoning: a relation API's whole value is deciding *for* you how related
rows are fetched — one query with a join, or two queries stitched in memory,
or N+1 without telling you which. Getting that wrong is the most common
performance problem in every ORM that has one, and it is invisible at the call
site. An explicit join is longer to type and there is never a question about
what ran.

The cost is honest too: **loading children per parent in a loop is N+1 queries,
and nothing will warn you.** Fetch them in one query with a join, or with a
single `inList()` over the parent ids, and group in JavaScript.

If you want relations, this is the wrong library — that is a fair conclusion to
reach from this page, and a better outcome than discovering it three months in.

## Subqueries

Any builder can be a subquery. Pass one to `DB.inList()`:

```ts
import DB from '@bakery/orm'

const activeCampuses = DB.from('campuses')
  .where('code', 'active')
  .select({ id: 'campuses.id' })

const q = DB.from('teachers').where('teachers.campusId', DB.inList(activeCampuses))
```

The inner query's parameters are spliced into the outer parameter list in order.

## CTEs

`DB.include(builder, name)` starts a `WITH` clause; chain `.table(name)` to
query it.

```ts
import DB from '@bakery/orm'

const activeUsers = DB.table('users').where('status', 'active')

const q = DB.include(activeUsers, 'active_users').table('active_users').selectAll()
// WITH "active_users" AS (SELECT * FROM "users" WHERE "status" = ?)
// SELECT "active_users".* FROM "active_users"
```

## Raw SQL

`DB.raw` is a tagged template. Interpolated values bind as parameters;
interpolated `DB.col()` references and nested builders inline as SQL.

```ts
import DB from '@bakery/orm'

const email = 'admin@example.com'
const q = DB.from('teachers').where(DB.raw`LOWER(email) = ${email} AND status = 'active'`)
```

A single-argument `.where()` takes the fragment as the whole condition. `DB.raw`
also accepts `DB.raw('sql text', [params])` when the SQL is not a literal.

Nothing inside a `DB.raw` template is validated. Interpolate values, never
identifiers.

## Running the query

| Method | Returns |
| --- | --- |
| `.array()` | every row |
| `.fetch()` / `.first()` | the first row or `undefined` (adds `LIMIT 1`) |
| `.value<T>()` / `.scalar<T>()` | the first column of the first row |
| `.column<T>()` | the first column of every row |
| `.exists()` | `boolean`, via `SELECT 1 FROM (…) LIMIT 1` |
| `.iterable()` | an async iterable, a chunk at a time |
| `.parse()` | `{ sql, params }` — builds nothing, runs nothing |

```ts
import DB from '@bakery/orm'

const posts = await DB.from('posts').where('posts.published', 1).array()
const one = await DB.from('posts').where('posts.slug', 'hello').fetch()
const total = await DB.from('posts').select({ n: DB.count('*') }).value<number>()
const slugs = await DB.from('posts').select({ slug: 'posts.slug' }).column<string>()
const any = await DB.from('posts').where('posts.authorId', 7).exists()
```

The builder is also a thenable: `await DB.from('posts')` runs `.array()`. Prefer
the explicit call — it is clearer, and it is the only way to get anything other
than an array.

`.fetch()` appends `LIMIT 1` when the query does not already have one. Without
that, "give me one row" scanned the whole table and materialised every row
before discarding all but the first.

Use `.iterable()` for result sets you do not want in memory at once:

```ts
import DB from '@bakery/orm'

export async function eachPost(fn: (row: unknown) => void) {
  for await (const row of DB.from('posts').orderBy('posts.id').iterable()) fn(row)
}
```

**It pages; it is not a server-side cursor.** Bun's `SQL` has no streaming API
at all — a query is a thenable, and every method on it resolves the whole
result — so the ORM wraps your statement in a derived table and walks it 500
rows at a time:

```sql
SELECT * FROM (<your SELECT>) AS bakery_stream LIMIT ? OFFSET ?
```

Two consequences worth knowing before you use it:

- **Memory is bounded by the chunk, not by the result.** That is the reason to
  reach for it, and it holds.
- **Chunk boundaries are only stable under a total order.** The statement is
  re-executed per chunk, so rows inserted or deleted while you walk can be seen
  twice or missed — the same hazard `LIMIT`/`OFFSET` paging has. Add an
  `ORDER BY` on a unique column, as above. If the table is being written to
  concurrently and you cannot tolerate a skip, [`seek()`](#cursor-paging-with-seek)
  is the construct that does not have this property.

## Reusing a builder

Builder methods mutate. `.clone()` gives an independent copy, which is how you
share a base query:

```ts
import DB from '@bakery/orm'

const base = DB.table('users').where('status', 'active')
const newest = base.clone().orderBy('createdAt', 'DESC').limit(10)
const oldest = base.clone().orderBy('createdAt', 'ASC').limit(10)
```

Without the clone, the second chain would append to the first.

## Transactions

`DB.transaction()` runs a callback inside one transaction and commits on return,
rolling back if it throws. The active connection is held in `AsyncLocalStorage`,
so builders inside the callback use the transaction without being handed
anything:

```ts
import DB from '@bakery/orm'

await DB.transaction(async () => {
  await DB.Update.table('accounts').set({ balance: 90 }).where('id', 1).run()
  await DB.Update.table('accounts').set({ balance: 110 }).where('id', 2).run()
})
```

The callback also receives the transaction adapter directly, for raw statements.
Work started but not awaited inside the callback escapes the transaction — await
everything.

## Next

- [Mutations](mutations.md) — insert, update, delete
- [Schema](schema.md) — what makes these queries typed
- [Adapters](adapters.md) — how the SQL differs per dialect
