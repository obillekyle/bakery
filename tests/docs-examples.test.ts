import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

/**
 * Every TypeScript example in `docs/` is compiled against the real packages.
 *
 * This exists because of what happened to `.docs/`: 33 of its 34 files carried
 * definite factual errors, and *every* code block that imported anything was
 * broken. Not through carelessness — the packages were split, `@server/*` and
 * `@database/*` died, `foreign()` became an error, and nothing connected any
 * of that to the prose. The docs stayed coherent and confident and wrong,
 * which is worse than being obviously stale.
 *
 * Prose cannot be tested. Imports, signatures and types can, and those are
 * what a reader copies. A doc example that no longer compiles is a bug report
 * filed against the commit that broke it, rather than against the person who
 * trusted it six months later.
 *
 * A block that is a deliberate fragment — a signature, a shape, a `…` — opts
 * out with `ts no-check`, and the checker requires a reason on the same line
 * so the escape hatch stays visible in review.
 */

const ROOT = `${import.meta.dir}/..`

/**
 * Per-process work dir. A fixed path looks fine in CI and breaks the moment two
 * runs overlap: each overwrites the other's `ex<N>.ts`, so failures get
 * attributed to whichever doc happened to claim that index. That produced a
 * confident, wrong "error in multi-host.md" during parallel authoring, which is
 * the same class of misattribution these docs exist to stop.
 */
const WORK = `${ROOT}/.cache/__docs-examples__.${process.pid}`

interface Example {
  /** Repo-relative doc path. */
  doc: string
  /** 1-based line of the opening fence, so a failure points at the source. */
  line: number
  lang: 'ts' | 'tsx'
  code: string
  file: string
}

const FENCE = /^```(\w+)([^\n]*)$/

/**
 * `file` is assigned centrally, in `beforeAll`, and **must not** be assigned
 * here.
 *
 * It used to be, from a counter declared inside this function — so the counter
 * restarted at 0 for every document and each doc's `ex0.ts` overwrote the
 * previous one's. Only the last writer of each index survived to disk: 103
 * blocks across the tree produced **18** files, so 85 examples were never
 * compiled at all, and the failures that did surface were attributed to
 * whichever doc happened to own that index in `examples[]` rather than the doc
 * the code came from.
 *
 * That made this file's whole claim — "every example compiles, so a broken one
 * fails on the commit that breaks it" — about one-sixth true, and quietly.
 */
function extract(doc: string, text: string): {
  examples: Omit<Example, 'file'>[]
  skippedWithoutReason: string[]
} {
  const lines = text.split('\n')
  const examples: Omit<Example, 'file'>[] = []
  const skippedWithoutReason: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i])
    if (!open) continue

    const lang = open[1]
    const meta = (open[2] || '').trim()

    // Consume to the closing fence regardless, so a ```bash block containing
    // a nested fence cannot desynchronise the scan.
    const start = i + 1
    let end = start
    while (end < lines.length && !/^```\s*$/.test(lines[end])) end++

    if (lang === 'ts' || lang === 'tsx') {
      if (/\bno-check\b/.test(meta)) {
        // `ts no-check — why` keeps the opt-out honest.
        if (!/no-check\s*[—-]\s*\S/.test(meta)) {
          skippedWithoutReason.push(`${doc}:${i + 1}  \`\`\`${lang} ${meta}`)
        }
      } else {
        const code = lines.slice(start, end).join('\n')
        examples.push({ doc, line: i + 1, lang, code })
      }
    }

    i = end
  }

  return { examples, skippedWithoutReason }
}

/**
 * `docs/` plus every published package README.
 *
 * The READMEs were the gap. They are the most public prose in the repo — a
 * package README *is* its npm landing page, and for most readers it is the only
 * page they will ever see — and they were the one body of examples nothing
 * compiled. Exactly the shape of the problem this file exists to prevent, with
 * a wider audience than `docs/`.
 */
async function docFiles(): Promise<string[]> {
  const patterns = [
    'docs/**/*.md',
    'packages/*/README.md',
    'packages/plugins/*/README.md',
  ]
  const found: string[] = []
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern)
    for await (const scanned of glob.scan({ cwd: ROOT, onlyFiles: true })) {
      found.push(scanned.replace(/\\/g, '/'))
    }
  }
  return found.sort()
}

const examples: Example[] = []
const skippedWithoutReason: string[] = []

/**
 * Spawning tsc costs several seconds, which overruns Bun's default 5s hook
 * timeout — so the compile lives in the test body, where a timeout can be
 * stated explicitly, and only the (fast) extraction happens in beforeAll.
 */
function compileExamples(): string {
  if (!examples.length) return ''
  const proc = Bun.spawnSync(
    ['bunx', 'tsc', '-p', `${WORK}/tsconfig.json`, '--noEmit'],
    { cwd: ROOT },
  )
  return `${proc.stdout.toString()}${proc.stderr.toString()}`
}

beforeAll(async () => {
  const docs = await docFiles()

  for (const doc of docs) {
    const text = await Bun.file(`${ROOT}/${doc}`).text()
    const result = extract(doc, text)
    // One counter across the whole tree, so `exN.ts` and `examples[N]` are the
    // same N and no document can overwrite another's files.
    for (const found of result.examples) {
      examples.push({ ...found, file: `${WORK}/ex${examples.length}.${found.lang}` })
    }
    skippedWithoutReason.push(...result.skippedWithoutReason)
  }

  if (!examples.length) return

  await rm(WORK, { recursive: true, force: true })
  for (const example of examples) {
    // Each block becomes its own module. `export {}` guarantees module scope
    // even for a block with no import, so two examples declaring the same name
    // cannot collide.
    await Bun.write(example.file, `${example.code}\nexport {}\n`)
  }

  await Bun.write(
    `${WORK}/tsconfig.json`,
    JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: {
          // Examples elide obvious things; unused locals are not the point.
          noUnusedLocals: false,
          noUnusedParameters: false,
        },
        include: ['*.ts', '*.tsx'],
        files: [
          '../../packages/core/src/global.d.ts',
          '../../packages/core/src/shared.d.ts',
          '../../packages/core/src/types.d.ts',
          '../../packages/orm/src/globals.d.ts',
        ],
      },
      null,
      2,
    ),
  )
  // Explicit, for the same reason the compile lives in the test body: reading
  // every doc and writing one module per example is comfortably more than
  // Bun's default 5s hook budget once the tree has a few dozen files, and a
  // hook timeout reports as an unnamed failure that says nothing about docs.
}, 120_000)

afterAll(async () => {
  await rm(WORK, { recursive: true, force: true })
})

describe('docs examples compile against the real packages', () => {
  test('every ts/tsx block typechecks', () => {
    // Map tsc's ex<N>.ts back to the doc and line a reader would be looking at.
    const failures: string[] = []
    for (const line of compileExamples().split('\n')) {
      const match = /ex(\d+)\.tsx?\((\d+),(\d+)\): (error .*)/.exec(line)
      if (!match) continue
      const example = examples[Number(match[1])]
      if (!example) continue
      failures.push(
        `${example.doc}:${example.line} (block line ${match[2]}) — ${match[4]}`,
      )
    }

    expect(failures).toEqual([])
    // Generous: one tsc invocation over every example in the tree.
  }, 180_000)

  test('no-check blocks state a reason', () => {
    // An unexplained opt-out is how a whole file quietly stops being checked.
    expect(skippedWithoutReason).toEqual([])
  })
})
