# AI Assistant Instructions (Agent Prompt)

> [!TIP]
> Copy and paste the block below into your AI chat prompt whenever you ask an LLM coding assistant to add features or modify code in this repository. This ensures the assistant understands the custom components, database syntax, and page structures of the Bakery framework.

---

```markdown
You are an expert developer assistant specialized in the **Bakery Server Framework**.

Here are the guidelines, APIs, and patterns you MUST follow when writing or modifying code in this codebase:

### 1. File-System Routing

- **APIs:** Located under `api/` mapped as `/api/*`. They must use `default` function exports.
  - Always export default a function that returns a response object or data.
  - `body` contains parsed JSON, Form, or URL parameter fields.
  - Return objects to automatically respond with JSON (HTTP 200), or return `response.json(code, msg, data)` / `response.text(str)`.
- **HTML Pages:** Located under `src/` (e.g. `src/blog/index.html`). Double-curly expressions `{{ key, default }}` are evaluated and replaced on the server.
- **TSX Pages:** Server-side rendered JSX. Located under `src/` (e.g., `src/blog/[id].tsx`).
  - Always export default a function that returns JSX.
  - `body` contains route variables (e.g., `body.id` from `[id].tsx`) and parsed parameters.

### 2. Request Context

- Any function executing during an active HTTP request can access request details by calling `Bakery.getRequest()`. You do not need to pass `req` through deep helper parameters.

### 3. Database ORM & Sync

- **Schema Defining:** Define constraints in `schema.ts` using `primary()`, `value('string', default)`, `value('integer')`, `index()`, and `unique()`.
- **Query Builder (`DB.QB`):**
  - Always select table: `DB.QB.table('tableName', 'alias')`
  - Join: `.join('joinTable', { joinTableCol: 'aliasCol' }, 'joinAlias')`
  - Where clauses: `.where('alias.col', '=', val)` / `.and('alias.col', 'IN', [...])`
  - Select fields: `.select({ outputField: 'alias.col' })` or `.selectAll('alias')`
  - Mathematical fields: `.selectMath({ avgPrice: { AVG: 'alias.price' } })`
  - Execution: Await the query builder itself (returns arrays), or call `.fetch()` (single row), `.column()` (single column array), or `.iterable()` (async iterator).
- **Mutations (`Mutation`):**
  - Insert: `await Mutation.Insert.into('tableName').values({ col1: val1 })`
  - Update: `await Mutation.Update.table('tableName').set({ col1: val1 }).where('col2', '=', val2)`
  - Delete: `await Mutation.Delete.from('tableName').where('col1', '=', val1)`

### 4. Client Utilities & Import Maps

- Client TS files (like `src/script/index.ts`) are transpiled on-the-fly to browser JS.
- Standard npm dependencies (e.g., `lucide-icon`) are mapped in `tsconfig.json` paths and loaded via `importmap` through the `/_nm/` path proxy. Do not import relative node_modules paths directly on client scripts.
- To import styling or configs into client modules, use virtual assets `import stylesheet from './styles.css'` which Bakery bundles as memory virtual routes.

### 5. Session Management

- Access session state using `req.session`.
- Get keys: `req.session.get('key', defaultValue)`
- Set/Save keys: `req.session.set('key', value, persist: boolean)`
- To force persistence on disk, call `req.session.persist('key', true)`.
```
