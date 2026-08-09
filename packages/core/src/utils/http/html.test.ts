import { beforeAll, describe, expect, test } from 'bun:test'
import { initConfig } from '../../core/config'
import { assembleHtml, injectIfHtml, withStatus } from './html'

// Self-contained: these previously relied on another test file having
// initialized the config first, so they failed when run in isolation.
beforeAll(async () => {
  await initConfig()
})

describe('assembleHtml', () => {
  test('injects head content into existing head tag', () => {
    const html = '<html><head><title>Test</title></head><body></body></html>'
    const result = assembleHtml(html)
    expect(result).toContain('<head>')
    expect(result).toContain('importmap')
  })

  test('injects body content before closing body tag', () => {
    const html = '<html><head></head><body>content</body></html>'
    const result = assembleHtml(html)
    expect(result).toContain('</body>')
  })

  test('adds head if missing', () => {
    const html = '<div>content</div>'
    const result = assembleHtml(html)
    expect(result).toContain('importmap')
  })

  test('replaces Google Fonts URLs', () => {
    const html =
      '<head><link href="https://fonts.googleapis.com/css2?family=Test"></head><body></body>'
    const result = assembleHtml(html)
    expect(result).toContain('/_gf/')
    expect(result).not.toContain('fonts.googleapis.com')
  })

  // The rewrite is gated on a `fonts.goog` substring check to skip the regex
  // for the overwhelmingly common no-fonts document. These pin the shapes that
  // gate has to keep letting through.
  test('replaces fonts.google.com as well as fonts.googleapis.com', () => {
    const result = assembleHtml(
      '<head><link href="http://fonts.google.com/css2?family=Test"></head><body></body>',
    )
    expect(result).toContain('/_gf/')
    expect(result).not.toContain('fonts.google.com')
  })

  test('replaces every Google Fonts URL, not just the first', () => {
    const result = assembleHtml(
      '<head><link href="https://fonts.googleapis.com/css2?a=1">' +
        '<link href="https://fonts.googleapis.com/css2?b=2"></head><body></body>',
    )
    expect(result).not.toContain('fonts.googleapis.com')
    expect(result.split('/_gf/').length - 1).toBe(2)
  })

  test('leaves a non-css2 fonts URL alone', () => {
    const result = assembleHtml(
      '<head><link href="https://fonts.googleapis.com/icon?family=X"></head><body></body>',
    )
    expect(result).toContain('fonts.googleapis.com/icon')
  })

  test('appends body injects when there is no closing body tag', () => {
    // The single-pass rewrite decides "no </body>" from the replacer never
    // firing rather than from a separate test() pass.
    const result = assembleHtml(
      '<head></head><p>bare</p>',
      {},
      { body: '<!--B-->' },
    )
    expect(result).toContain('<!--B-->')
    expect(result.indexOf('<!--B-->')).toBeGreaterThan(
      result.indexOf('<p>bare</p>'),
    )
  })

  test('inserts body injects before the closing body tag when present', () => {
    const result = assembleHtml(
      '<head></head><body><p>x</p></body>',
      {},
      { body: '<!--B-->' },
    )
    expect(result).toContain('<!--B--></body>')
    expect(result.split('<!--B-->').length - 1).toBe(1)
  })

  test('interpolates template params', () => {
    const html = '<html><head></head><body><h1>{{title}}</h1></body></html>'
    const result = assembleHtml(html, { title: 'Hello World' })
    expect(result).toContain('Hello World')
    expect(result).not.toContain('{{title}}')
  })

  test('keeps unresolved params as-is', () => {
    const html = '<html><head></head><body>{{missing}}</body></html>'
    const result = assembleHtml(html, {})
    expect(result).toContain('{{missing}}')
  })

  test('uses fallback values', () => {
    const html = '<html><head></head><body>{{val, fallback}}</body></html>'
    const result = assembleHtml(html, {})
    expect(result).toContain('fallback')
  })

  test('filters $$ params from page params script', () => {
    const html = '<html><head></head><body></body></html>'
    const result = assembleHtml(html, { title: 'Hi', $$head: 'injected' })
    expect(result).toContain('title')
    expect(result).not.toContain('$$head')
  })
})

describe('assembleHtml injection safety', () => {
  const page = '<html><head></head><body></body></html>'

  test('request params named $$head/$$body/$$prio are NOT injected as markup', () => {
    // For GET requests `params` is the query string, so honouring these keys
    // was a reflected XSS on every dynamic page and every error page.
    const result = assembleHtml(page, {
      $$head: '<script>alert(1)</script>',
      $$body: '<script>alert(2)</script>',
      $$prio: '<script>alert(3)</script>',
    })
    expect(result).not.toContain('alert(1)')
    expect(result).not.toContain('alert(2)')
    expect(result).not.toContain('alert(3)')
  })

  test('server-supplied injects are still honoured', () => {
    const result = assembleHtml(
      page,
      {},
      {
        head: '<link rel="stylesheet" href="/a.css">',
        body: '<script src="/a.js"></script>',
        prio: '<script src="/prio.js"></script>',
      },
    )
    expect(result).toContain('/a.css')
    expect(result).toContain('/a.js')
    expect(result).toContain('/prio.js')
    expect(result).not.toContain('<!--prio-->')
  })

  test('$-patterns in params do not splice document content', () => {
    // `$'` in a replacement *string* expands to everything after the match.
    const result = assembleHtml(page, { evil: "$' and $& and $` and $$" })
    const params = JSON.parse(
      result.slice(
        result.indexOf('__PAGE_PARAMS__ = ') + '__PAGE_PARAMS__ = '.length,
        result.indexOf('</script>', result.indexOf('__PAGE_PARAMS__')),
      ),
    )
    expect(params.evil).toBe("$' and $& and $` and $$")
  })

  test('$-patterns in server injects do not splice document content', () => {
    const marker = '<!--BODY-END-MARKER-->'
    const result = assembleHtml(
      `<html><head></head><body>${marker}</body></html>`,
      {},
      { body: "$'" },
    )
    // A spliced `$'` would duplicate the marker; a literal one appears once.
    expect(result.split(marker).length - 1).toBe(1)
  })
})

describe('injectIfHtml', () => {
  test('returns null for non-HTML string', async () => {
    const result = await injectIfHtml('plain text')
    expect(result).toBeNull()
  })

  test('returns Response for HTML string', async () => {
    const result = await injectIfHtml('<div>hello</div>')
    expect(result).not.toBeNull()
    expect(result).toBeInstanceOf(Response)
  })

  test('returns Response for HTML Response', async () => {
    const input = new Response('<p>hi</p>', {
      headers: { 'Content-Type': 'text/html' },
    })
    const result = await injectIfHtml(input)
    expect(result).not.toBeNull()
    expect(result).toBeInstanceOf(Response)
  })

  test('returns null for non-HTML Response', async () => {
    const input = new Response('data', {
      headers: { 'Content-Type': 'application/json' },
    })
    const result = await injectIfHtml(input)
    expect(result).toBeNull()
  })

  test('does not double-inject', async () => {
    const first = await injectIfHtml('<div>hello</div>')
    expect(first).not.toBeNull()
    const second = await injectIfHtml(first!)

    expect(second).toBe(first)
  })
})

// ---------------------------------------------------------------------------
// Streaming path (large / unknown-size Response and Blob bodies)
//
// Structural markers used throughout: the buffered path always sets a content
// ETag; the streamed path never does (no hash without buffering). So
// `headers.get('ETag')` distinguishes which path produced a Response.
// ---------------------------------------------------------------------------

const enc = new TextEncoder()

/** A Response whose body arrives as a byte stream in `chunkSize` slices. */
function streamResponseOf(
  html: string,
  chunkSize = 7,
  headers: Record<string, string> = {},
) {
  const bytes = enc.encode(html)
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        c.enqueue(bytes.slice(i, i + chunkSize))
      }
      c.close()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/html', ...headers },
  })
}

/** Declares a large Content-Length so the router commits to streaming early. */
function largeStreamResponseOf(html: string, chunkSize = 7) {
  return streamResponseOf(html, chunkSize, {
    'content-length': String(1 << 20),
  })
}

describe('injectIfHtml streaming path', () => {
  const fixtures: Record<string, { html: string; injects?: any }> = {
    'plain head/body': {
      html: '<html><head><title>t</title></head><body><p>x</p></body></html>',
    },
    'server injects incl. prio': {
      html: '<html><head></head><body><p>x</p></body></html>',
      injects: {
        head: '<link rel="stylesheet" href="/a.css">',
        body: '<script src="/a.js"></script>',
        prio: '<script src="/prio.js"></script>',
      },
    },
    'google fonts link': {
      html:
        '<html><head><link href="https://fonts.googleapis.com/css2?family=Test"></head>' +
        '<body></body></html>',
    },
    'google fonts in inline style @import': {
      html:
        '<html><head><style>@import url(https://fonts.googleapis.com/css2?family=X);</style></head>' +
        '<body></body></html>',
    },
    'multiple fonts links': {
      html:
        '<html><head><link href="https://fonts.googleapis.com/css2?a=1">' +
        '<link href="http://fonts.google.com/css2?b=2"></head><body></body></html>',
    },
    'non-css2 fonts link left alone': {
      html:
        '<html><head><link href="https://fonts.googleapis.com/icon?family=X"></head>' +
        '<body></body></html>',
    },
    'no closing body tag': {
      html: '<html><head></head><p>bare</p>',
      injects: { body: '<!--B-->' },
    },
    'uppercase closing body tag': {
      html: '<html><head></head><body><p>x</p></BODY></html>',
      injects: { body: '<!--B-->' },
    },
    'fonts url inside body injects': {
      html: '<html><head></head><body></body></html>',
      injects: {
        body: '<link href="https://fonts.googleapis.com/css2?family=I">',
      },
    },
    '$-patterns in injects do not splice': {
      html: '<html><head></head><body><!--M--></body></html>',
      injects: { head: "$' $& $`", body: "$' $& $`" },
    },
  }

  for (const [name, { html, injects }] of Object.entries(fixtures)) {
    test(`golden parity, buffered vs streamed: ${name}`, async () => {
      const expected = assembleHtml(html, {}, injects)
      const res = await injectIfHtml(largeStreamResponseOf(html), {}, injects)

      expect(res).not.toBeNull()
      // Structural check that the streamed path was actually taken.
      expect(res!.headers.get('ETag')).toBeNull()
      expect(await res!.text()).toBe(expected)
    })
  }

  test('golden parity at every chunk split point', async () => {
    const html =
      '<html><head><link href="https://fonts.googleapis.com/css2?f=1"></head>' +
      '<body><p>content</p></body></html>'
    const expected = assembleHtml(html, {}, { body: '<!--B-->' })
    const bytes = enc.encode(html)

    for (let split = 0; split <= bytes.length; split++) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          if (split > 0) c.enqueue(bytes.slice(0, split))
          if (split < bytes.length) c.enqueue(bytes.slice(split))
          c.close()
        },
      })
      const res = await injectIfHtml(
        new Response(stream, {
          headers: {
            'content-type': 'text/html',
            'content-length': String(1 << 20),
          },
        }),
        {},
        { body: '<!--B-->' },
      )
      expect(res!.headers.get('ETag')).toBeNull()
      expect(await res!.text()).toBe(expected)
    }
  })

  test('unknown-size stream over the threshold streams, with parity', async () => {
    const pad = '<p>' + 'x'.repeat(1024) + '</p>'
    const html =
      '<html><head><title>big</title></head><body>' +
      pad.repeat(80) + // ~82KB body, comfortably over 64KB
      '</body></html>'
    const expected = assembleHtml(html)

    const res = await injectIfHtml(streamResponseOf(html, 4096))
    expect(res).not.toBeNull()
    expect(res!.headers.get('ETag')).toBeNull()
    expect(await res!.text()).toBe(expected)
  })

  test('streamed output starts before the input finishes', async () => {
    let feed!: ReadableStreamDefaultController<Uint8Array>
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        feed = c
      },
    })
    const head = '<html><head><title>t</title></head><body>' + 'y'.repeat(2048)
    const tail = '<p>tail</p></body></html>'

    feed.enqueue(enc.encode(head))
    const res = await injectIfHtml(
      new Response(source, {
        headers: {
          'content-type': 'text/html',
          'content-length': String(1 << 20),
        },
      }),
    )
    expect(res).not.toBeNull()

    // Read output while the input stream is still open. A buffering
    // implementation would never resolve this read.
    const reader = res!.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value!.length).toBeGreaterThan(0)

    feed.enqueue(enc.encode(tail))
    feed.close()

    let out = new TextDecoder().decode(first.value)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += new TextDecoder().decode(value)
    }
    expect(out).toBe(assembleHtml(head + tail))
  })

  test('params-bearing responses take the buffered path regardless of size', async () => {
    const html = '<html><head></head><body><h1>{{title}}</h1></body></html>'
    const res = await injectIfHtml(largeStreamResponseOf(html), {
      title: 'Hello',
    })
    expect(res).not.toBeNull()
    // Buffered marker: content ETag present.
    expect(res!.headers.get('ETag')).not.toBeNull()
    const text = await res!.text()
    expect(text).toContain('<h1>Hello</h1>')
    expect(text).not.toContain('{{title}}')
  })

  test('head tag beyond the probe window falls back to buffered', async () => {
    // 80KB of comment padding before <head>: the streamed path cannot know
    // whether to use the prepend fallback until it has seen this much, so it
    // must buffer instead — and the output must still be byte-identical.
    const html =
      `<!--${'p'.repeat(80 * 1024)}-->` +
      '<html><head></head><body><p>deep</p></body></html>'
    const res = await injectIfHtml(streamResponseOf(html, 4096))
    expect(res).not.toBeNull()
    expect(res!.headers.get('ETag')).not.toBeNull()
    expect(await res!.text()).toBe(assembleHtml(html))
  })

  test('document with no head tag falls back to buffered prepend', async () => {
    const html = '<div>no head here</div>' + '<p>' + 'z'.repeat(256) + '</p>'
    const res = await injectIfHtml(largeStreamResponseOf(html))
    expect(res).not.toBeNull()
    expect(res!.headers.get('ETag')).not.toBeNull()
    expect(await res!.text()).toBe(assembleHtml(html))
  })

  test('streamed path preserves status and custom headers, drops content-length', async () => {
    const html = '<html><head></head><body>s</body></html>'
    const input = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(html))
          c.close()
        },
      }),
      {
        status: 203,
        headers: {
          'content-type': 'text/html',
          'content-length': String(1 << 20),
          'x-custom': 'kept',
        },
      },
    )
    const res = await injectIfHtml(input)
    expect(res).not.toBeNull()
    expect(res!.headers.get('ETag')).toBeNull()
    expect(res!.status).toBe(203)
    expect(res!.headers.get('x-custom')).toBe('kept')
    expect(res!.headers.get('content-length')).toBeNull()
    expect(res!.headers.get('content-type')).toBe('text/html; charset=utf-8')
    // With no ETag there is no sendResponse hook to add the default cache
    // policy, so the streamed path must set it itself (guarded, like
    // sendResponse, on the handler not having set one).
    expect(res!.headers.get('cache-control')).toBe('no-cache')
  })

  test('streamed path keeps a handler-set Cache-Control', async () => {
    const html = '<html><head></head><body>s</body></html>'
    const res = await injectIfHtml(
      streamResponseOf(html, 7, {
        'content-length': String(1 << 20),
        'cache-control': 'private, max-age=60',
      }),
    )
    expect(res!.headers.get('ETag')).toBeNull()
    expect(res!.headers.get('cache-control')).toBe('private, max-age=60')
  })

  test('streamed responses are branded against double injection', async () => {
    const html = '<html><head></head><body>once</body></html>'
    const res = await injectIfHtml(largeStreamResponseOf(html))
    expect(res).not.toBeNull()
    expect(await injectIfHtml(res!)).toBe(res)
  })

  test('empty streamed body returns null', async () => {
    const empty = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.close()
        },
      }),
      { headers: { 'content-type': 'text/html' } },
    )
    expect(await injectIfHtml(empty)).toBeNull()
  })

  test('non-HTML stream returns null untouched', async () => {
    const res = await injectIfHtml(
      streamResponseOf('{"a":1}', 7, {
        'content-type': 'application/json',
        'content-length': String(1 << 20),
      }),
    )
    expect(res).toBeNull()
  })

  test('large HTML Blob streams with parity, small Blob stays buffered', async () => {
    const bigHtml =
      '<html><head></head><body>' +
      '<p>' +
      'b'.repeat(70 * 1024) +
      '</p>' +
      '</body></html>'
    const big = new Blob([bigHtml], { type: 'text/html' })
    const bigRes = await injectIfHtml(big)
    expect(bigRes).not.toBeNull()
    expect(bigRes!.headers.get('ETag')).toBeNull()
    expect(await bigRes!.text()).toBe(assembleHtml(bigHtml))

    const smallHtml = '<html><head></head><body>s</body></html>'
    const small = new Blob([smallHtml], { type: 'text/html' })
    const smallRes = await injectIfHtml(small)
    expect(smallRes).not.toBeNull()
    expect(smallRes!.headers.get('ETag')).not.toBeNull()
    expect(await smallRes!.text()).toBe(assembleHtml(smallHtml))
  })
})

describe('withStatus', () => {
  test('injectIfHtml alone produces a 200, whatever the page says', async () => {
    // Documenting the constraint the fix works around: the only status signal
    // reaching this function is `params`, which is request-derived, so the
    // status has to be applied by the caller that knows the error code.
    const page = await injectIfHtml('<html><body>Not Found</body></html>')
    expect(page!.status).toBe(200)
  })

  test('restates a Response without disturbing body or headers', async () => {
    const page = (await injectIfHtml('<html><body>gone</body></html>'))!
    const restated = withStatus(page, 410)

    expect(restated.status).toBe(410)
    expect(restated.headers.get('Content-Type')).toBe(
      page.headers.get('Content-Type'),
    )
    expect(restated.headers.get('ETag')).toBe(page.headers.get('ETag'))
    expect(await restated.text()).toContain('gone')
  })

  test('carries the injection brand across the rebuild', async () => {
    const page = (await injectIfHtml('<html><body>hi</body></html>'))!
    const restated = withStatus(page, 404)

    // Without this, processResponse would inject the client bundle a second
    // time into a page that already has it.
    expect(await injectIfHtml(restated)).toBe(restated)
  })

  test('is a no-op when the status already matches', async () => {
    const page = (await injectIfHtml('<html><body>hi</body></html>'))!
    expect(withStatus(page, 200)).toBe(page)
  })
})
