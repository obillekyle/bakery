import { describe, expect, test } from 'bun:test'

/**
 * The two spelling tells, enforced rather than remembered.
 *
 * Both are the same class of problem: not wrong English, just visibly not the
 * house voice, and invisible to every other gate in the repo. A typecheck has
 * no opinion about an em dash and a test suite has no opinion about
 * `normalised`, so before this file the only thing standing between the repo
 * and 3,436 of them was whoever happened to be reading.
 *
 * **Scanned whole, not sampled.** The equivalent check in a sibling project
 * went through four narrower versions, each reporting clean while the dashes
 * were still on screen, because each one looked at a subset somebody had
 * reasoned about. A byte scan over every tracked text file cannot miss, and
 * it costs about a second.
 */

const ROOT = `${import.meta.dir}/..`

/**
 * Built from code points, not written literally, because this file is
 * scanned by its own check.
 *
 * Writing them as characters passed every local run and failed on the first
 * CI run, which reads as a platform difference and is not one: `git ls-files`
 * does not list an untracked file, so the gate could not see itself until the
 * commit that added it. Any pattern added below has the same hazard.
 */
const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)

function tracked(): string[] {
  const out = Bun.spawnSync(['git', 'ls-files'], { cwd: ROOT })
  return out.stdout.toString().trim().split('\n').filter(Boolean)
}

/** Binary and vendored formats, where a byte scan means nothing. */
const BINARY = /\.(png|jpg|jpeg|gif|ico|woff2?|svg|lock|db|pdf)$/

/**
 * Exceptions, by name and with a reason, so adding one is a deliberate edit.
 *
 * Empty, and it stays that way by removing the thing that needed an
 * exception rather than by granting one. `CHANGELOG.md` was the only
 * candidate: cutver rewrote it whole on every release from the commit
 * bodies, which the house rule exempts on purpose, so each release put 37 em
 * dashes back into a tracked file and this gate then refused to publish.
 *
 * It failed in the worst available place. `publish.yml` re-runs the suite
 * against the *tag's* tree, which is the release commit, which is the only
 * commit carrying a freshly generated changelog: green on every branch push
 * and red at the irreversible step, with `v2.0.0-alpha.18` and
 * `v2.0.0-rc.0` both tagged and neither on npm. The file is deleted and
 * `changelog.file` is off in cutver.yml; the GitHub release pages, which is
 * where people actually read this, still get the summarised body.
 */
const GENERATED: Record<string, string> = {}

describe('no em dash or en dash reaches anything published', () => {
  test('every tracked text file is clean', async () => {
    const offenders: string[] = []
    for (const file of tracked()) {
      if (BINARY.test(file)) continue
      if (file in GENERATED) continue
      let text: string
      try {
        text = await Bun.file(`${ROOT}/${file}`).text()
      } catch {
        // Not decodable as text, so not prose. The BINARY list above catches
        // the known formats; this catches the ones nobody has added yet.
        continue
      }
      for (const [i, line] of text.split('\n').entries()) {
        if (line.includes(EM) || line.includes(EN)) {
          offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  }, 60_000)
})

/**
 * British spelling, on the surfaces where it is always wrong.
 *
 * Three layers, and only one of them is this test's business:
 *
 *   - **Prose** (markdown outside code, doc comments) converts. That is here.
 *   - **Identifiers** are report-only. Renaming `colour: keyof Theme` is a
 *     refactor with call sites, not a spelling fix, and one pass that tried
 *     it rewrote `theme[r.colour]` inside a template literal and broke the
 *     typecheck.
 *   - **Platform tokens** (`color`, `text-align: center`) are already spelled
 *     the platform's way and must never move in either direction.
 *
 * So this reads markdown *outside* fenced blocks and code spans, and `/** *\/`
 * doc comments in source, and nothing else. A backticked token is skipped
 * everywhere, because a backtick in a comment means "this is a name": the
 * pass that introduced this file rewrote exactly one of those, and the
 * comment then described a variable that did not exist.
 */
const BRITISH =
  /\b(behaviour|behavioural|colour|coloured|centre|centred|grey|greyed|honour|honours|honoured|honouring|favour|labour|licence|neighbour|neighbours|neighbourhood|catalogue|cancelled|cancelling|labelled|labelling|modelled|amortised|authoris(e|ed|es|ing)|canonicalis(e|ed|ing)|emphasis(ed|es|ing)|externalis(e|ed|es|ing)|finalis(e|ed|es)|generalis(e|ed|es)|initialis(e|ed|ing)|internalis(e|ed|ing)|materialis(e|ed|es)|memois(e|ed|es|ing)|memoisation|normalis(e|ed|es|ing)|normalisation|optimis(e|ed|es|ing)|optimisation|organis(e|ed|es)|organisation|parenthesis(ed|ing)|recognis(e|ed|es|ing)|serialis(e|ed|es|ing)|serialisation|specialis(e|ed)|synthesis(ed|es)|unauthoris(e|ed)|uninitialis(e|ed)|unrecognis(e|ed))\b/gi

/** Markdown prose: outside fenced blocks and outside inline code spans. */
function markdownProse(text: string): string {
  return text
    .replace(/^([ \t]*)(```+|~~~+)[^\n]*\n[\s\S]*?\n[ \t]*\2[^\n]*$/gm, '')
    .replace(/`[^`\n]+`/g, '')
}

/** Doc-comment bodies, with code spans removed. */
function docComments(text: string): string {
  const out: string[] = []
  for (const m of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    out.push(m[0].replace(/`[^`\n]+`/g, ''))
  }
  return out.join('\n')
}

describe('published prose is American English', () => {
  test('markdown outside code is clean', async () => {
    const offenders: string[] = []
    for (const file of tracked()) {
      if (!file.endsWith('.md')) continue
      if (file in GENERATED) continue
      const text = markdownProse(await Bun.file(`${ROOT}/${file}`).text())
      for (const m of text.matchAll(BRITISH)) {
        offenders.push(`${file}  ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  }, 60_000)

  test('doc comments are clean, because jsdoc publishes them', async () => {
    // Not exempt as "code comments": these are rendered into a page under the
    // maintainer's name, the same as a README.
    const offenders: string[] = []
    for (const file of tracked()) {
      if (!/\.(ts|tsx)$/.test(file)) continue
      const text = docComments(await Bun.file(`${ROOT}/${file}`).text())
      for (const m of text.matchAll(BRITISH)) {
        offenders.push(`${file}  ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  }, 60_000)
})
