import { describe, test, expect } from 'bun:test'
import { assembleHtml, injectIfHtml } from './html'

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
    const html = '<head><link href="https://fonts.googleapis.com/css2?family=Test"></head><body></body>'
    const result = assembleHtml(html)
    expect(result).toContain('/_gf/')
    expect(result).not.toContain('fonts.googleapis.com')
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
    // $$ params are injected into head, not included in __PAGE_PARAMS__
    expect(result).not.toContain('$$head')
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
    // Should return the same Response (already injected)
    expect(second).toBe(first)
  })
})
