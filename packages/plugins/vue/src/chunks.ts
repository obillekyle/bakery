import { Bakery } from '@bakery/core/core/bakery'
import { Logger } from '@bakery/core/logger'
import { fs, response } from '@bakery/core/utils'
import { ETag } from '@bakery/core/utils/http'
import { VUE_VERSION } from './utils'

const logger = new Logger('vue')

export const VUE_CHUNK_PREFIX = '/_vue/'

const BUNDLE_DEFINES = {
  __VUE_OPTIONS_API__: 'true',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
}

/** Serves the self-hosted Vue runtime that `Bakery.config.importMap` points at. */
export async function serveVueChunk(
  path: string,
  req: Request,
): Promise<Response> {
  if (path !== `${VUE_CHUNK_PREFIX}${VUE_VERSION}.js`) {
    return response.error('Not Found', 404)
  }

  const dir = fs.resolve(Bakery.cacheDir, 'vue-official', 'chunks')
  const fileName = `${VUE_VERSION}.js`

  let sourcePath = ''
  try {
    sourcePath = Bun.resolveSync('vue/dist/vue.esm-bundler.js', Bakery.root)
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
