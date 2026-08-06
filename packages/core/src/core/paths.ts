import { FileSystem as fs } from '../utils/fs'

/**
 * Where the framework's own files live, as opposed to where the application
 * lives.
 *
 * Two roots were previously conflated on `process.cwd()`: the app root (its
 * `src/`, `public/`, `api/`, `schema.ts`) and the framework root (the client
 * runtime it serves at `/_client/*`, the dashboard's assets, the tsconfig
 * templates). Framework assets were addressed as `<cwd>/.server/...`, which
 * only holds while the framework is a directory inside the app.
 *
 * Derived from this module's own location, so it keeps working once the
 * framework is a workspace package or resolved out of `node_modules`.
 *
 * Use `frameworkPath()` for files the framework ships. Use `Bakery.root` (cwd)
 * for anything the application owns.
 */
export const frameworkRoot: string = fs.resolve(import.meta.dir, '..')

/** Resolve a path against the framework's own root. */
export function frameworkPath(...segments: string[]): string {
  return fs.resolve(frameworkRoot, ...segments)
}
