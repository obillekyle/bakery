import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * A Vue app written to a temporary directory, shaped like the admin area that
 * made production bundling necessary: a catch-all page statically importing
 * twelve page components, seven of them with a `<script server>` block (one
 * guarded by a middleware), each using shared widgets, under a layout. Forty
 * `.vue` files in all, the size of the app that measured 48 to 51 requests per
 * cold admin page.
 *
 * The framework is imported by file path, since a directory outside the
 * repository has no tsconfig to resolve `@bakery-framework/*` through, and
 * `node_modules` is a link to the repository's so `vue` resolves from the
 * app's root, which is where the runtime chunk looks for it.
 */
const REPO = resolve(import.meta.dir, '../..').replaceAll('\\', '/')

export const VUE_APP_PAGES = 12
/** Of the page components, the ones with a server block: the first seven. */
export const VUE_APP_SERVER_PAGES = 7
/** The page component whose middleware answers 401 to `x-test-role: guest`. */
export const VUE_APP_GUARDED = '/admin/pages/page6.vue'

function write(root: string, path: string, text: string) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/**
 * Delete an app `writeVueApp` wrote: the `node_modules` link first, on its
 * own, and only then the rest.
 *
 * The order is the point. The link leads to the repository's real
 * `node_modules`, and a recursive delete that follows it empties that instead
 * of removing a link. `rmdirSync` takes a Windows junction away as the
 * reparse point it is; `unlinkSync` does the same for a symlink elsewhere.
 */
export function removeVueApp(root: string): void {
  const link = join(root, 'node_modules')
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) {
    if (process.platform === 'win32') rmdirSync(link)
    else unlinkSync(link)
  }
  if (existsSync(link)) {
    throw new Error(
      `${link} is still there: refusing to delete ${root} through it`,
    )
  }
  // On Windows a server just killed can hold its files for a moment.
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  })
}

/** Writes the app and returns its directory. */
export function writeVueApp(prefix = 'bakery-vue-app-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix)).replaceAll('\\', '/')
  symlinkSync(
    join(REPO, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  write(
    root,
    'server.config.ts',
    `import vuePlugin from '${REPO}/packages/plugins/vue/src/index.ts'

export default {
  root: 'src',
  rateLimit: false,
  plugins: [vuePlugin()],
}
`,
  )

  write(
    root,
    'src/shared/format.ts',
    `export const label = (n: number): string => 'item ' + n\n`,
  )
  write(root, 'src/shared/brand.css', '.brand { letter-spacing: 0.1em }\n')
  // A stylesheet imported by a module, which a served page supports too: an
  // SFC's own script importing one fails unbundled, so a test relying on it
  // would pass only built.
  write(
    root,
    'src/shared/theme.ts',
    `import './brand.css'\nexport const theme: string = 'brand'\n`,
  )

  write(
    root,
    'src/components/Brand.vue',
    `<meta module-only />
<script setup>
import { theme } from '../shared/theme'
</script>

<template><b :class="theme">Brand</b></template>
`,
  )

  // Two widgets for each page component.
  for (let i = 0; i < VUE_APP_PAGES * 2; i++) {
    write(
      root,
      `src/components/Widget${i}.vue`,
      `<meta module-only />
<script setup lang="ts">
import { label } from '../shared/format'
const text = label(${i})
</script>

<template><span class="widget">{{ text }}</span></template>

<style scoped>
.widget { margin: 1px }
</style>
`,
    )
  }

  for (let p = 0; p < VUE_APP_PAGES; p++) {
    const widgets = [p * 2, p * 2 + 1]
    const server =
      p >= VUE_APP_SERVER_PAGES
        ? ''
        : `/admin/pages/page${p}.vue` === VUE_APP_GUARDED
          ? `<script server>
import { getRequest } from '${REPO}/packages/core/src/core/index.ts'

export async function middleware() {
  if (getRequest().headers.get('x-test-role') === 'guest') {
    return new Response('Unauthorized', { status: 401 })
  }
}

export const total = ${p * 100}
</script>

`
          : `<script server>
export const total = ${p * 100}
</script>

`
    write(
      root,
      `src/admin/pages/page${p}.vue`,
      `<meta module-only />
${server}<script setup>
import Brand from '../../components/Brand.vue'
${widgets.map(w => `import Widget${w} from '../../components/Widget${w}.vue'`).join('\n')}
</script>

<template>
  <section class="page" id="page${p}">
    <Brand />
    ${server ? `<p class="total">{{ total }}</p>` : ''}
    ${widgets.map(w => `<Widget${w} />`).join('\n    ')}
  </section>
</template>
`,
    )
  }

  write(
    root,
    'src/admin/layout.vue',
    `<template>
  <div class="chrome"><slot /></div>
</template>

<style>
.chrome { padding: 4px }
</style>
`,
  )

  write(
    root,
    'src/admin/[...slug].vue',
    `<meta title="Admin" />
<script server>
export const viewer = 'registrar'
</script>

<script setup>
${Array.from(
  { length: VUE_APP_PAGES },
  (_, p) => `import Page${p} from './pages/page${p}.vue'`,
).join('\n')}
</script>

<template>
  <main>
    <p id="viewer">{{ viewer }}</p>
    ${Array.from({ length: VUE_APP_PAGES }, (_, p) => `<Page${p} />`).join('\n    ')}
  </main>
</template>

<style>
main { color: rebeccapurple }
</style>
`,
  )

  write(
    root,
    'src/index.vue',
    `<script setup>
import Brand from './components/Brand.vue'
import Widget0 from './components/Widget0.vue'
</script>

<template>
  <h1 id="home">Home</h1>
  <Brand />
  <Widget0 />
</template>
`,
  )

  return root
}
