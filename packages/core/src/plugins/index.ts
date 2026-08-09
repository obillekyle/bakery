/**
 * The plugin-authoring surface, as one barrel.
 *
 * Every other public directory in core has an `index.ts` and `plugins/` did
 * not, so `@bakery-framework/core/plugins` pointed straight at `routes.ts` — which meant
 * `definePlugin` and `ServerPlugin` were only reachable through
 * `@bakery-framework/core/plugins/types`, a second subpath for one concept. It also broke
 * under TypeScript's `paths` resolution, which maps `@bakery-framework/core/plugins` to
 * this directory and looks for an index rather than consulting the export map.
 *
 * Two files, one entry point: `routeTable`/`dispatch` from `routes`, and the
 * plugin shape from `types`.
 */
export * from './routes'
export * from './types'
