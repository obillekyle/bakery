import { Bakery } from '@bakery-framework/core/core/bakery'
import { Logger } from '@bakery-framework/core/logger'
import { fs, response } from '@bakery-framework/core/utils'
import { ETag } from '@bakery-framework/core/utils/http'
import { vueBuildVariant } from './compile'
import { VUE_VERSION } from './utils'

const logger = new Logger('vue')

export const VUE_CHUNK_PREFIX = '/_vue/'

const BUNDLE_DEFINES = {
  __VUE_OPTIONS_API__: 'true',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
}

const VUE_ENTRIES = {
  runtime: 'vue/dist/vue.runtime.esm-bundler.js',
  full: 'vue/dist/vue.esm-bundler.js',
} as const

/**
 * The one canonical URL for the served Vue build — the import-map alias
 * (`setup.ts`) and the request check below both read it, so they cannot drift.
 *
 * The variant is part of the filename, not just of the entry choice, because
 * the chunk cache is keyed on this name with the *source's* mtime: flipping
 * `build` in `server.config.ts` does not touch `vue.esm-bundler.js` on disk,
 * so a shared name would keep serving the previous variant out of cache
 * indefinitely.
 */
export function vueChunkPath(): string {
  return `${VUE_CHUNK_PREFIX}${VUE_VERSION}.${vueBuildVariant()}.js`
}

/** Serves the self-hosted Vue runtime that `Bakery.config.importMap` points at. */
export async function serveVueChunk(
  path: string,
  req: Request,
): Promise<Response> {
  if (path !== vueChunkPath()) {
    return response.error('Not Found', 404)
  }

  const variant = vueBuildVariant()
  const dir = fs.resolve(Bakery.cacheDir, 'vue-official', 'chunks')
  const fileName = `${VUE_VERSION}.${variant}.js`

  let sourcePath = ''
  try {
    sourcePath = Bun.resolveSync(VUE_ENTRIES[variant], Bakery.root)
  } catch {
    return response.error('Vue not found', 404)
  }
  const sourceMtime = Bun.file(sourcePath).lastModified

  const file = await fs.getOrCreateCachedFile(
    dir,
    fileName,
    sourceMtime,
    async () => {
      const result = await Bun.build({
        entrypoints: [sourcePath],
        target: 'browser',
        format: 'esm',
        minify: import.meta.env.PROD,
        define: BUNDLE_DEFINES,
      })

      if (!result.success) {
        logger.log(
          `Build failed: ${result.logs.map(l => l.message).join('; ')}`,
          'error',
        )
        return null
      }
      return result.outputs[0].arrayBuffer()
    },
  )

  if (!file) return response.error('Vue chunk not built', 500)

  const res = await ETag.sendFile(file, req)
  res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  return res
}
