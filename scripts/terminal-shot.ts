#!/usr/bin/env bun
/**
 * The terminal screenshot in the README, generated from a real dev boot.
 *
 *     bun run scripts/terminal-shot.ts    # writes assets/shot.html and the SVGs
 *
 * **Why a screenshot at all.** The README describes a server that resolves
 * routes off the filesystem and checks a schema against the database on the way
 * up, and it described that in a monochrome fence. The boot output is coloured
 * on purpose — green for the two things that had to succeed before the port
 * opened, blue for an address worth clicking, yellow for the numbers a reader
 * might want to change — and a fence throws all of that away.
 *
 * **Generated, not captured by hand.** The server is booted, its output read
 * until it reports the port open, and the process torn down. Refreshing the
 * image after an output change is one command, and the HTML that produced it
 * sits in the diff next to the SVGs.
 *
 * **Two panes, because GitHub serves README images through its own proxy**,
 * which strips the CSS a `prefers-color-scheme` rule inside the image would
 * need. `<picture>` does the choosing instead, so there is a light file and a
 * dark one.
 */

/** GitHub's own light and dark palettes — the image sits inside a GitHub page. */
const THEMES = {
  dark: {
    bg: '#0d1117',
    chrome: '#161b22',
    border: '#30363d',
    fg: '#c9d1d9',
    grey: '#8b949e',
    red: '#ff7b72',
    green: '#7ee787',
    yellow: '#d29922',
    blue: '#4493f8',
    cyan: '#79c0ff',
    magenta: '#d2a8ff',
    title: '#8b949e',
  },
  light: {
    bg: '#ffffff',
    chrome: '#f6f8fa',
    border: '#d0d7de',
    fg: '#24292f',
    grey: '#6e7781',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    cyan: '#0550ae',
    magenta: '#8250df',
    title: '#6e7781',
  },
} as const

/** Widened to `string`: the two palettes share keys, not values. */
type Theme = Record<keyof (typeof THEMES)['dark'], string>

interface Run {
  text: string
  colour: keyof Theme
  bold: boolean
  dim: boolean
  italic: boolean
}

/**
 * ANSI SGR into runs.
 *
 * Only the codes the logger emits — `packages/core/src/logger/logger.ts` is the
 * whole palette. Anything unrecognised resets rather than guessing: a wrong
 * colour here is a claim about the output that is not true.
 *
 * `37` is the logger's "regular", which means the foreground rather than a
 * literal white; painting it white would leave it invisible on the light pane.
 */
function parse(line: string): Run[] {
  const runs: Run[] = []
  let colour: keyof Theme = 'fg'
  let bold = false
  let dim = false
  let italic = false
  let at = 0

  const SGR = /\x1b\[([0-9;]*)m/g
  let m: RegExpExecArray | null
  const push = (text: string) => {
    if (text) runs.push({ text, colour, bold, dim, italic })
  }

  while ((m = SGR.exec(line))) {
    push(line.slice(at, m.index))
    at = m.index + m[0].length
    for (const code of (m[1] || '0').split(';')) {
      if (code === '1') bold = true
      else if (code === '2') dim = true
      else if (code === '3') italic = true
      else if (code === '31') colour = 'red'
      else if (code === '32') colour = 'green'
      else if (code === '33') colour = 'yellow'
      else if (code === '34') colour = 'blue'
      else if (code === '35') colour = 'magenta'
      else if (code === '36') colour = 'cyan'
      else if (code === '37') colour = 'fg'
      else if (code === '90') colour = 'grey'
      else {
        colour = 'fg'
        bold = false
        dim = false
        italic = false
      }
    }
  }
  push(line.slice(at))
  return runs
}

const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '')

const TITLE = 'my-app — bakery'

function pane(lines: string[], theme: Theme, name: string): string {
  const body = lines
    .map(line => {
      const spans = parse(line)
        .map(r => {
          const style = [
            `color:${theme[r.colour]}`,
            r.bold ? 'font-weight:600' : '',
            r.dim ? 'opacity:.65' : '',
            r.italic ? 'font-style:italic' : '',
          ]
            .filter(Boolean)
            .join(';')
          return `<span style="${style}">${esc(r.text)}</span>`
        })
        .join('')
      return spans || '&nbsp;'
    })
    .join('\n')

  return `<div class="win" id="${name}" style="--bg:${theme.bg};--chrome:${theme.chrome};--border:${theme.border};--title:${theme.title}">
  <div class="bar"><i class="d r"></i><i class="d y"></i><i class="d g"></i><span class="t">${TITLE}</span></div>
  <pre>${body}</pre>
</div>`
}

const root = new URL('..', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
)

/**
 * Boot the example app and read until it reports the port open.
 *
 * Port 3311 rather than the configured 3000, because a screenshot must not
 * depend on 3000 being free and must not take it from whatever is already
 * listening there. The number is put back below: 3000 is what the config ships
 * and what a reader would see.
 */
const PORT = '3311'
const proc = Bun.spawn(
  ['bun', '--smol', 'run', '../../packages/cli/src/index.ts', '--dev'],
  {
    cwd: `${root}/apps/example`,
    env: { ...process.env, PORT, FORCE_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
)

const dec = new TextDecoder()
const reader = proc.stdout.getReader()
const READY = /Rate limit:/
const deadline = Date.now() + 30_000
let raw = ''

// Read until the last boot line rather than for a fixed number of seconds: a
// timer either truncates a slow boot or pads every fast one.
while (!READY.test(strip(raw)) && Date.now() < deadline) {
  const next = await Promise.race([
    reader.read(),
    new Promise<null>(r => setTimeout(() => r(null), 1500)),
  ])
  if (!next || next.done) break
  raw += dec.decode(next.value)
}

/**
 * `kill()` reaches the process Bun started and not the worker that one started
 * in turn, which leaves the port held and makes the next run fail to bind.
 * `/T` takes the tree with it.
 */
proc.kill()
if (process.platform === 'win32') {
  Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
}
await proc.exited

const isNetwork = (l: string) => /Network/.test(strip(l))

const lines = raw
  .split('\n')
  .map(l => l.replace(/\r$/, ''))
  // Three cosmetic edits, and they are the only ones made to the output:
  //   * the port goes back to the configured 3000, as above;
  //   * the machine's LAN addresses are not something to publish, so the first
  //     Network row is kept and the rest dropped;
  //   * that row's address becomes a documentation one.
  // Every other character is the server's own.
  .map(l => l.replaceAll(`:${PORT}`, ':3000'))
  .filter((l, i, all) => !isNetwork(l) || all.findIndex(isNetwork) === i)
  .map(l => l.replace(/\d+\.\d+\.\d+\.\d+/g, '192.168.1.24'))
  // Every row is padded by the logger, so a row with nothing to say still
  // arrives carrying its level and source.
  .filter(l => !/^\[[A-Z]\]\s+\S+$/.test(strip(l).trim()))

while (lines.length && !strip(lines[lines.length - 1] as string).trim())
  lines.pop()

if (!lines.length) {
  console.error('no output captured: check that the example app still boots')
  process.exit(1)
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>bakery — terminal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  body { margin: 0; padding: 40px; background: #8b8b8b; display: flex; flex-direction: column; gap: 40px; align-items: flex-start; }
  .win {
    background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
    overflow: hidden; width: max-content; box-shadow: 0 8px 30px rgba(0,0,0,.18);
  }
  .bar {
    height: 34px; background: var(--chrome); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px; padding: 0 13px;
  }
  .d { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
  .r { background: #ff5f57 } .y { background: #febc2e } .g { background: #28c840 }
  .t {
    margin-left: 10px; font-size: 12px; color: var(--title);
    /* Google Sans if this machine has it, and the usual UI stack if not. */
    font-family: "Google Sans", "Google Sans Text", ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  }
  pre {
    margin: 0; padding: 18px 22px 20px;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px; line-height: 1.62; letter-spacing: 0;
    white-space: pre; tab-size: 2;
    /* Ligatures off, and this is not taste. JetBrains Mono draws the arrow on
       each address row as one glyph and would do the same to any flag spelled
       with two dashes. Everything in this window is something a reader retypes,
       and a screenshot that renders a string differently from how it must be
       typed is worse than no screenshot. */
    font-variant-ligatures: none;
    font-feature-settings: "liga" 0, "calt" 0;
  }
</style>
${pane(lines, THEMES.dark, 'dark')}
${pane(lines, THEMES.light, 'light')}
`

const asset = (name: string) => `${root}/assets/${name}`

await Bun.write(asset('shot.html'), html)
console.log(`  assets/shot.html  (${lines.length} lines, for previewing)`)

/**
 * The same output as SVG, which is what the README embeds.
 *
 * **Flowing tspans, not pinned ones.** Computing an `x` per span from a fixed
 * advance would draw correctly only in the font it was measured against, and a
 * reader without JetBrains Mono would get every span overlapping the last.
 * Letting them flow means any monospace lays the line out correctly and only
 * the total width changes, so the font stack degrades instead of breaking. It
 * is also why this embeds no font: a few KB of text rather than 160 KB of
 * base64, and nothing to re-subset when a glyph appears.
 */
function svg(theme: Theme): string {
  const cols = Math.max(...lines.map(l => strip(l).length))
  const FONT = 13
  const LINE = FONT * 1.62
  const PAD = 20
  const CHROME = 34
  const w = Math.ceil(cols * FONT * 0.6 + PAD * 2)
  const h = Math.ceil(lines.length * LINE + PAD * 2 + CHROME)

  const rows = lines
    .map((line, i) => {
      const y = (PAD + CHROME + (i + 0.85) * LINE).toFixed(1)
      const spans = parse(line)
        .map(r => {
          const style = [
            `fill:${theme[r.colour]}`,
            r.bold ? 'font-weight:600' : '',
            r.dim ? 'opacity:.65' : '',
            r.italic ? 'font-style:italic' : '',
          ]
            .filter(Boolean)
            .join(';')
          return `<tspan style="${style}" xml:space="preserve">${esc(r.text)}</tspan>`
        })
        .join('')
      return spans
        ? `<text x="${PAD}" y="${y}" xml:space="preserve">${spans}</text>`
        : ''
    })
    .filter(Boolean)
    .join('\n    ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="bakery booting in development: the schema checked against the database, then the server listening on port 3000">
  <rect width="${w}" height="${h}" rx="10" fill="${theme.bg}" stroke="${theme.border}"/>
  <path d="M0 10a10 10 0 0 1 10-10h${w - 20}a10 10 0 0 1 10 10v${CHROME - 10}H0z" fill="${theme.chrome}"/>
  <line x1="0" y1="${CHROME}" x2="${w}" y2="${CHROME}" stroke="${theme.border}"/>
  <circle cx="19" cy="17" r="5.5" fill="#ff5f57"/>
  <circle cx="38" cy="17" r="5.5" fill="#febc2e"/>
  <circle cx="57" cy="17" r="5.5" fill="#28c840"/>
  <text x="76" y="21" font-family="Google Sans, Google Sans Text, ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif" font-size="11.5" fill="${theme.title}">${TITLE}</text>
  <g font-family="JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT}" style="font-variant-ligatures:none;font-feature-settings:'liga' 0,'calt' 0">
    ${rows}
  </g>
</svg>
`
}

for (const [name, theme] of Object.entries(THEMES)) {
  await Bun.write(asset(`terminal-${name}.svg`), svg(theme))
  console.log(`  assets/terminal-${name}.svg`)
}
