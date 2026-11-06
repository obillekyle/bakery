import { beforeAll, describe, expect, test } from 'bun:test'

/**
 * What the browser runtime asks the browser to fetch.
 *
 * `client/utils.ts` writes its rules while it loads, behind a `typeof document`
 * gate, so this gives it a document for the length of one import of its own: the
 * query makes it a new module instance, whichever test loaded it first.
 */
type Rules = {
  prefetch: { urls: string[]; eagerness?: string }[]
  prerender: { urls: string[]; eagerness?: string }[]
}

const link = (href: string, prefetch?: string) => ({
  getAttribute: (name: string) => {
    if (name === 'href') return href
    return name === 'prefetch' ? (prefetch ?? null) : null
  },
})

let rules: Rules

beforeAll(async () => {
  const written: { textContent?: string }[] = []
  const g = globalThis as any

  g.document = {
    readyState: 'complete',
    body: null,
    head: { appendChild: (el: { textContent?: string }) => written.push(el) },
    createElement: () => ({}),
    querySelector: () => null,
    querySelectorAll: () => [
      link('/one'),
      link('/two'),
      link('/out', 'false'),
      link('/account/logout'),
      link('#top'),
      link('https://other.example/'),
      link('/report.pdf'),
      link('/three?utm_source=mail'),
    ],
  }
  g.MutationObserver = class {
    observe() {}
  }

  try {
    const entry = './utils?speculation-rules'
    await import(entry)
  } finally {
    delete g.document
    delete g.MutationObserver
  }

  rules = JSON.parse(written[0].textContent as string)
})

describe('speculation rules', () => {
  test('nothing is fetched until there is intent', () => {
    // With no eagerness a list rule fetches at once: a sidebar of 32 links asked
    // for all 32 pages at every load, and moderate asked for none.
    expect(rules.prefetch[0].eagerness).toBe('moderate')
    expect(rules.prerender[0].eagerness).toBe('moderate')
  })

  test('both rules list the same filtered links', () => {
    expect(rules.prefetch[0].urls).toEqual(['/one', '/two'])
    expect(rules.prerender[0].urls).toEqual(['/one', '/two'])
  })
})
