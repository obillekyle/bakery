/**
 * Hash everything the boot-time schema sync reads: the schema source files
 * (resolved with the same probe order as orm/sync/load.ts — configured path,
 * then the `orm/` folder layout, then a root `schema.ts`) plus the DB target,
 * since switching `DB_URL` changes what "synced" means.
 *
 * Returns `null` for any indeterminate state — a configured path that does not
 * exist, an unreadable file — so `classifySchemaSync` fails closed into
 * re-syncing. Total absence of a schema is *not* indeterminate (it is a
 * supported state for the defaults) and hashes to a stable value.
 *
 * `base` defaults to the app's cwd, which is what `dev.ts` wants and the only
 * value it passes. It is a parameter at all because `fs.cwd` is a module-level
 * constant evaluated at import time, so a test cannot reach this function's
 * probe any other way without `process.chdir` before the import — process-global
 * state of exactly the kind convention 9 exists to keep out of the suite.
 *
 * The `@bakery-framework/core/utils` import stays dynamic, as it was inline in
 * `dev.ts`: that barrel must not enter the module graph at `dev.ts` import time.
 */
export async function computeSchemaHash(
  configured: string | undefined,
  base?: string,
): Promise<string | null> {
  const { fs, Try } = await import('@bakery-framework/core/utils')
  const cwd = base ?? fs.cwd

  const files: string[] = []
  const scanDir = async (dir: string) => {
    for await (const file of new Bun.Glob('*.ts').scan({
      cwd: dir,
      absolute: true,
    })) {
      files.push(file)
    }
  }

  const [error] = await Try.catch(
    (async () => {
      if (configured) {
        const path = fs.resolve(cwd, configured)
        if (await fs.isDir(path)) {
          await scanDir(path)
        } else if (await Bun.file(path).exists()) {
          files.push(path)
        } else {
          // Configured-but-missing is SyncService's SCHEMA_NOT_FOUND case:
          // let the sync run and produce its proper error.
          throw new Error(`configured schema path not found: ${path}`)
        }
      } else if (await Bun.file(`${cwd}/orm/index.ts`).exists()) {
        await scanDir(`${cwd}/orm`)
      } else if (await Bun.file(`${cwd}/schema.ts`).exists()) {
        files.push(`${cwd}/schema.ts`)
      }
    })(),
  )
  if (error) return null

  files.sort()
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(process.env.DB_URL || process.env.DATABASE_URL || '')
  for (const file of files) {
    hasher.update(`\0${file}\0`)
    const [readError, content] = await Try.catch(Bun.file(file).text())
    if (readError) return null
    hasher.update(content)
  }
  return hasher.digest('hex')
}
