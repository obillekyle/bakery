import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Bakery } from '../../core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../../core/config'
import { hostStore } from '../../core/context'
import {
  DOMTools,
  clearHeadBodyCache,
  headBodyCache,
  initHostImportMaps,
  initImportMap,
} from './dom'

describe('DOMTools', () => {
  test('isHTML detects HTML strings', async () => {
    const result = await DOMTools.isHTML('<div>Hello</div>')
    expect(result.content).toBe('<div>Hello</div>')
  })

  test('isHTML returns empty for non-HTML', async () => {
    const result = await DOMTools.isHTML('just plain text')
    expect(result.content).toBe('')
  })

  test('isHTML returns empty for SVG', async () => {
    const result = await DOMTools.isHTML('<?xml version="1.0"?><svg></svg>')
    expect(result.content).toBe('')
  })

  test('isHTML handles Response with HTML content-type', async () => {
    const res = new Response('<p>hi</p>', {
      headers: { 'Content-Type': 'text/html' },
    })
    const result = await DOMTools.isHTML(res)
    expect(result.content).toContain('<p>hi</p>')
  })

  test('isHTML returns empty for non-HTML Response', async () => {
    const res = new Response('data', {
      headers: { 'Content-Type': 'application/json' },
    })
    const result = await DOMTools.isHTML(res)
    expect(result.content).toBe('')
  })

  test('params creates script tag with page params', () => {
    const result = DOMTools.params({ title: 'Hello', count: '5' })
    expect(result).toContain('window.__PAGE_PARAMS__')
    expect(result).toContain('title')
    expect(result).toContain('Hello')
  })

  test('params filters out $$ keys', () => {
    const result = DOMTools.params({ title: 'Hi', $$head: 'skip', $$body: 'skip' })
    expect(result).not.toContain('$$head')
    expect(result).not.toContain('$$body')
    expect(result).toContain('title')
  })

  test('params escapes < so a value cannot close the script tag', () => {
    const result = DOMTools.params({ x: '</script><script>alert(1)</script>' })
    expect(result).not.toContain('</script><script>')
    expect(result).toContain('\\u003c')
  })

  test('params escapes U+2028/U+2029', () => {
    // Legal raw inside JSON, and legal inside a JS string literal only since
    // ES2019 — escaping them is what `escapeScriptJson` already does for every
    // other inline-script payload in the framework.
    //
    // Built with fromCharCode deliberately: a literal U+2028 in this file is
    // invisible and gets mangled on rewrite (see CLAUDE.md > Gotchas).
    const LS = String.fromCharCode(0x2028)
    const PS = String.fromCharCode(0x2029)
    const result = DOMTools.params({ a: LS, b: PS })

    expect(result).toContain('\\u2028')
    expect(result).toContain('\\u2029')
    expect(result).not.toContain(LS)
    expect(result).not.toContain(PS)
  })

  test('params still round-trips through JSON.parse', () => {
    const result = DOMTools.params({ title: 'Hello', n: '5' })
    const json = result.slice(
      result.indexOf('= ') + 2,
      result.lastIndexOf('</script>'),
    )
    expect(JSON.parse(json)).toEqual({ title: 'Hello', n: '5' })
  })
})

describe('DOMTools content-type helpers', () => {
  test('isHTMLContentType accepts html and xhtml, rejects others', () => {
    expect(DOMTools.isHTMLContentType('text/html')).toBe(true)
    expect(DOMTools.isHTMLContentType('text/html; charset=utf-8')).toBe(true)
    expect(DOMTools.isHTMLContentType('application/xhtml+xml')).toBe(true)
    expect(DOMTools.isHTMLContentType('application/json')).toBe(false)
    expect(DOMTools.isHTMLContentType('')).toBe(false)
  })

  test('htmlResponseInit carries status and headers, minus content-length', () => {
    const res = new Response('x', {
      status: 418,
      statusText: 'teapot',
      headers: {
        'content-type': 'text/html',
        'content-length': '1',
        'x-keep': 'yes',
      },
    })
    const init = DOMTools.htmlResponseInit(res)
    expect(init.status).toBe(418)
    expect(init.statusText).toBe('teapot')
    expect(init.headers.get('content-length')).toBeNull()
    expect(init.headers.get('x-keep')).toBe('yes')
  })
})

describe('import-map normalisation', () => {
  /**
   * The process-level map (`initImportMap`) and the per-host maps
   * (`initHostImportMaps`) used to normalise entries with two separate copies
   * of the same code, and the copies had drifted: one special-cased the entry
   * *key*, the other tested the entry *value*. `{ legacyByValue:
   * './.server/client/utils' }` was therefore rewritten to `/_client/utils.js`
   * by the process path and left alone by the host path, for the same input.
   *
   * They now share one helper, so the assertion is simply that both paths agree
   * on every entry — which is the property that cannot be restored by accident
   * if someone inlines one of them again.
   */
  const ENTRIES: Record<string, string> = {
    // The entry that exposed the drift.
    legacyByValue: './.server/client/utils',
    legacyByValueBare: '.server/client/utils',
    // Live special case: the alias always resolves to the served runtime.
    '@client/utils': '/somewhere/else.js',
    relative: './assets/x.js',
    bare: 'assets/x.js',
    'wildcard/*': './assets/*',
    absolute: '/already/absolute.js',
    remote: 'https://cdn.example.test/x.js',
  }

  const HOST = 'tenant.example'

  function parseImportMap(tag: string): Record<string, string> {
    const json = tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</script>'))
    return JSON.parse(json).imports
  }

  let processMap: Record<string, string>
  let hostMap: Record<string, string>

  beforeAll(async () => {
    await initConfig()
    __setTestConfig({
      importMap: ENTRIES,
      hosts: { [HOST]: { importMap: ENTRIES } },
    })

    await initImportMap()
    initHostImportMaps()

    processMap = parseImportMap(DOMTools.importMap())
    hostMap = await hostStore.run(
      { hostname: HOST, config: Bakery.config },
      async () => parseImportMap(DOMTools.importMap()),
    )
  })

  afterAll(() => {
    __resetTestConfig()
    clearHeadBodyCache()
  })

  test('the host map and the process map agree on every entry', () => {
    const disagreements: string[] = []

    for (const key of Object.keys(ENTRIES)) {
      const cleanKey = key.replace(/\*$/, '')
      if (processMap[cleanKey] !== hostMap[cleanKey]) {
        disagreements.push(
          `${cleanKey}: process=${processMap[cleanKey]} host=${hostMap[cleanKey]}`,
        )
      }
    }

    expect(disagreements).toEqual([])
  })

  test('normalisation results are the ones both paths were meant to produce', () => {
    // Pinned on the host map; the test above makes the process map identical.
    expect(hostMap['@client/utils']).toBe('/_client/utils.js')
    expect(hostMap.relative).toBe('/assets/x.js')
    expect(hostMap.bare).toBe('/assets/x.js')
    expect(hostMap['wildcard/']).toBe('/assets/')
    expect(hostMap.absolute).toBe('/already/absolute.js')
    expect(hostMap.remote).toBe('https://cdn.example.test/x.js')
  })

  test('the pre-split `.server/client/utils` value is no longer special-cased', () => {
    // Those two cases were the only `.server/` references left in the repo and
    // pointed at a directory the workspace split deleted. They are normalised
    // like any other relative path now rather than silently redirected.
    expect(hostMap.legacyByValue).toBe('/.server/client/utils')
    expect(hostMap.legacyByValueBare).toBe('/.server/client/utils')
  })
})

describe('clearHeadBodyCache', () => {
  // This test had no `expect` at all: it asserted that the call did not throw,
  // which a function whose body had been deleted would also satisfy. The cache
  // is exported, so assert the thing the name promises.
  test('empties the per-host head/body cache', () => {
    headBodyCache.set('probe.example', { head: '<meta>', body: '<div>' })
    expect(headBodyCache.get('probe.example')).toBeDefined()

    clearHeadBodyCache()
    expect(headBodyCache.get('probe.example')).toBeUndefined()
  })
})
