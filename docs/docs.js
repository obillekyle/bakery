/* ------------------------------------------------------------------ nav data
   `pages.json`, not a literal here: the sidebar has to be able to describe a
   version other than the one this shell was served from.

   It stays explicit rather than derived from the files on disk — the order is an
   editorial decision, and deriving it would make a rename silently reshuffle the
   site. Adding a page still means adding a line, just in a file that ships at
   every ref instead of one that only exists at `main`.

   Filled by `loadNav()` before the first route, so nothing reads it empty.    */
let NAV = []
let FLAT = []

/**
 * `README` is the root and is never in the sidebar, but it is the first stop in
 * prev/next and has to be searched. Prepended rather than listed in
 * `pages.json`, because a page every version has is not a page worth declaring.
 */
function setNav(groups) {
  NAV = groups
  FLAT = [
    ['README', 'Introduction'],
    ...groups.flatMap(g => g.items),
    ['CHANGELOG', 'Changelog'],
  ]
}

const REPO = 'https://github.com/obillekyle/bakery'
document.getElementById('gh-link').href = REPO

/* ------------------------------------------------------------------ markdown
   Small on purpose. It covers what these docs actually use — headings, fenced
   code, tables, nested lists, blockquotes, inline spans — and nothing else. */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** GitHub's heading-slug rules, so an existing `#anchor` link still lands. */
const slug = s => s.toLowerCase().replace(/`/g, '').replace(/[^\w\s-]/g, '')
  .trim().replace(/\s+/g, '-')

/**
 * A version as an anchor: `0.1.0-beta.2` becomes `0-1-0-beta-2`.
 *
 * The dots are turned into separators rather than dropped. Plain `slug` deletes
 * them — it follows GitHub's rules, where punctuation vanishes — which would
 * make `0.1.2` into `012`, unreadable in a URL and ambiguous besides: `2.30`
 * and `23.0` both come out `230`.
 */
const versionSlug = v => slug(String(v).replace(/\./g, '-'))

/**
 * The id for one heading, unique within the document it belongs to.
 *
 * **Two headings with the same words used to get the same id.** Every release
 * body carries a `Fixes`, so on the changelog all twenty-seven of them were
 * `#fixes` and every link went to the first — the page jumped somewhere
 * plausible and wrong, which is worse than not moving at all. Ordinary pages
 * have the same problem wherever a word repeats.
 *
 * Two mechanisms, because the two cases want different answers. Inside a scope
 * — one release — the heading hangs off the version, so `Fixes` under `0.1.2`
 * is `#0-1-2-fixes`: stable across releases being added above it, and legible.
 * Without a scope, a repeat takes a counter the way GitHub's do, `#header` then
 * `#header-1`, so the first of them keeps the id any existing link already uses.
 */
function headingId(lvl, text, scope, seen) {
  const base = scope
    ? (lvl <= 2 ? scope : `${scope}-${slug(text)}`)
    : slug(text)

  const n = seen.get(base) || 0
  seen.set(base, n + 1)
  return n ? `${base}-${n}` : base
}

const KEYWORDS = /\b(import|export|from|default|const|let|var|function|return|await|async|if|else|for|while|of|in|new|class|extends|implements|interface|type|enum|as|typeof|keyof|declare|module|namespace|public|private|readonly|static|try|catch|finally|throw|switch|case|break|continue|satisfies|true|false|null|undefined|void|never|any|string|number|boolean|this|super|yield|delete)\b/

/** Token-level highlighting: each piece is escaped as it is emitted, so no
    span markup can ever be produced from the source text itself. */
function highlight(code, lang) {
  if (lang === 'json') lang = 'ts'
  if (!/^(ts|tsx|js|jsx|json|bash|sh)$/.test(lang || '')) return esc(code)
  const shell = lang === 'bash' || lang === 'sh'
  const pattern = shell
    ? /(#[^\n]*)|('[^']*'|"[^"]*")|(\b(?:bun|bunx|npm|npx|git|cd|export|curl|sudo|docker|ls|rm|mkdir)\b)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('[^'\n]*'|"[^"\n]*"|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g
  let out = '', last = 0, m
  while ((m = pattern.exec(code))) {
    out += esc(code.slice(last, m.index))
    const [txt] = m
    if (m[1]) out += `<span class="tok-${shell ? 'c' : 'c'}">${esc(txt)}</span>`
    else if (m[2]) out += `<span class="tok-s">${esc(txt)}</span>`
    else if (shell) out += `<span class="tok-k">${esc(txt)}</span>`
    else if (m[3]) out += `<span class="tok-n">${esc(txt)}</span>`
    else if (KEYWORDS.test(txt)) out += `<span class="tok-k">${esc(txt)}</span>`
    else if (code[m.index + txt.length] === '(') out += `<span class="tok-f">${esc(txt)}</span>`
    else out += esc(txt)
    last = m.index + txt.length
  }
  return out + esc(code.slice(last))
}

/** Inline spans. Code is extracted first so nothing inside a `code` span is
    re-read as emphasis or a link. */
function inline(s, page) {
  const codes = []
  s = s.replace(/`([^`]+)`/g, (_, c) => `@@CODE${codes.push(c) - 1}@@`)
  s = esc(s)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" style="max-width:100%">`)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${resolveHref(href.trim(), page)}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(])_([^_]+)_(?=[\s.,)]|$)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  // `[0-9]` rather than `\d`: this file is written by tooling more than once,
  // and a lone backslash in a regex literal is exactly the thing that gets
  // eaten in transit — it already was, turning this into a match for "d+".
  return s.replace(/@@CODE([0-9]+)@@/g, (_, i) => `<code>${esc(codes[i])}</code>`)
}

/**
 * Turn a link as written in the .md into one that works here.
 *
 * Three cases, and the middle one is the whole reason this function exists:
 * a doc-to-doc `../guides/routing.md#anchor` has to become a hash route, or
 * every internal link on the site 404s. Links that leave `docs/` — into
 * `packages/`, or a gitignored maintainer file — go to GitHub instead, since
 * there is nothing here to serve them.
 */
function resolveHref(href, page) {
  if (/^(https?:|mailto:|#)/.test(href)) return href
  const [path, hash] = href.split('#')
  if (!path) return `#${hash}`
  const dir = page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : ''
  const parts = (dir ? dir.split('/') : []).concat(path.split('/'))
  const stack = []
  let escaped = false
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') { if (!stack.length) escaped = true; else stack.pop() }
    else stack.push(part)
  }
  const joined = stack.join('/')
  if (escaped || !/\.md$/i.test(path)) return `${REPO}/blob/main/${joined}`
  return routeHref(joined.replace(/\.md$/i, ''), hash)
}

  // The markdown renderer: one branch per block construct. Splitting it by
  // construct spreads the line-lookahead state the parser depends on.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: markdown block parser
function render(src, page, scope) {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  let html = '', i = 0
  const toc = []
  // Per document, which for the changelog means per release: ids are unique
  // within one call, and across calls the scope keeps them apart.
  const seen = new Map()

  while (i < lines.length) {
    const line = lines[i]

    // fenced code
    const fence = /^```(\S*)(.*)$/.exec(line)
    if (fence) {
      const lang = fence[1] || ''
      const buf = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++])
      i++
      const raw = buf.join('\n')
      html += `<div class="code-wrap"><span class="code-lang">${esc(lang || 'text')}</span>` +
        `<button class="copy-btn" type="button">Copy</button>` +
        `<pre><code>${highlight(raw, lang)}</code></pre></div>`
      continue
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const lvl = h[1].length, text = h[2].trim()
      const id = headingId(lvl, text, scope, seen)
      if (lvl === 2 || lvl === 3) toc.push({ lvl, text: text.replace(/`/g, ''), id })
      const anchor = lvl > 1 ? `<a class="anchor" href="${routeHref(page, id)}">#</a>` : ''
      html += `<h${lvl} id="${id}">${inline(text, page)}${anchor}</h${lvl}>`
      i++
      continue
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { html += '<hr>'; i++; continue }

    // table
    if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1] || '')) {
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const head = cells(line)
      i += 2
      let body = ''
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        body += `<tr>${cells(lines[i++]).map(c => `<td>${inline(c, page)}</td>`).join('')}</tr>`
      }
      html += `<table><thead><tr>${head.map(c => `<th>${inline(c, page)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`
      continue
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      html += `<blockquote>${render(buf.join('\n'), page).html}</blockquote>`
      continue
    }

    // list — indentation decides nesting, two spaces per level
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = []
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i])
        if (m) {
          items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3], cont: [] })
          i++
        } else if (items.length && lines[i].trim() && !/^\s*(#{1,6}|>|```)/.test(lines[i])) {
          items[items.length - 1].cont.push(lines[i].trim())   // lazy continuation
          i++
        } else if (items.length && !lines[i].trim() && /^\s*([-*+]|\d+\.)\s+/.test(lines[i + 1] || '')) {
          i++
        } else break
      }
      html += buildList(items, 0, page)
      continue
    }

    if (!line.trim()) { i++; continue }

    // paragraph
    const buf = []
    while (i < lines.length && lines[i].trim() &&
      !/^(\s*([-*+]|\d+\.)\s+|>|#{1,6}\s|```|\s*\|)/.test(lines[i]) &&
      !/^\s*(---|\*\*\*|___)\s*$/.test(lines[i])) buf.push(lines[i++])
    html += `<p>${inline(buf.join('\n'), page)}</p>`
  }
  return { html, toc }
}

function buildList(items, start, page) {
  const base = items[start].indent
  const ordered = items[start].ordered
  let out = ordered ? '<ol>' : '<ul>'
  let i = start
  while (i < items.length && items[i].indent >= base) {
    if (items[i].indent > base) {
      const from = i
      while (i < items.length && items[i].indent > base) i++
      out = out.replace(/<\/li>$/, `${buildList(items, from, page)}</li>`)
      continue
    }
    const text = [items[i].text, ...items[i].cont].join('\n')
    out += `<li>${inline(text, page)}</li>`
    i++
  }
  return out + (ordered ? '</ol>' : '</ul>')
}

/* ------------------------------------------------------------- versioned docs
 *
 * `?v=` reads the docs at another point in the project's history — a version,
 * a tag, or a branch:
 *
 *     ?v=1.1.0        the docs as they shipped with 1.1.0
 *     ?v=v1.1.0       the same, said the way the tag is written
 *     ?v=main         whatever is on a branch right now
 *
 * **Fetched from raw.githubusercontent at that ref, not built.** Publishing a
 * copy of the site per release would multiply every page by the number of
 * versions and still only cover the ones someone remembered to build. Every tag
 * already contains its own `docs/`, so the content exists for free — including
 * for branches, which no build could have anticipated.
 *
 * The query survives hash navigation on its own: changing `location.hash` never
 * touches the search string, so every internal link stays inside the version
 * being read without a single link needing to know about it.
 */
/** `owner/name`, derived from the repository link rather than written twice. */
const RAW = `https://raw.githubusercontent.com/${REPO.replace(/^https?:\/\/github\.com\//, '')}`

function requestedRef() {
  const v = new URLSearchParams(location.search).get('v')
  return v && v.trim() ? v.trim() : null
}

/**
 * The ref a visitor who asked for nothing gets: the latest **stable** release.
 *
 * **Pages serves `docs/` from the default branch, and that is not the same as
 * the released documentation.** A project developing 2.0 on `main` publishes a
 * site describing 2.0 while every reader who has not opted in is running 1.2.3
 * — so the default landing page documents features they do not have, and the
 * badge over it names a version the page is not about.
 *
 * Only the markdown moves. The shell, `versions.json` and this file are always
 * the default branch's, because that is what Pages serves; the ref decides
 * where the *pages* are read from.
 */
let DEFAULT_REF = null

/** What to read, whether or not anybody asked. */
function effectiveRef() {
  return requestedRef() ?? DEFAULT_REF
}

/**
 * Resolve it once, before the first route.
 *
 * **Probed rather than assumed, because a tag has to be able to serve itself.**
 * `pages.json` is newer than most tags in every repository that has one — the
 * sidebar used to be a literal in this file — so pointing at a release that
 * predates it would fetch a 404, fall back to *this* shell's sidebar, and list
 * pages that version does not have. Every link would then land on an apology.
 *
 * So the tag is used only when it carries its own sidebar, and the default is
 * the branch until then. That is wrong in the safe direction, and it corrects
 * itself the first time a project releases after adopting the file.
 */
async function resolveDefaultRef() {
  const KEY = 'bakery-docs-default-ref'
  const cached = sessionStorage.getItem(KEY)
  if (cached !== null) {
    DEFAULT_REF = cached || null
    return
  }

  try {
    const res = await fetch('versions.json')
    if (!res.ok) return
    const { latest } = await res.json()
    if (typeof latest !== 'string' || !latest) return

    const ref = refFor(latest)
    const probe = await fetch(
      `${RAW}/${encodeURIComponent(ref)}/docs/pages.json`,
      { method: 'HEAD' },
    )
    DEFAULT_REF = probe.ok ? latest : null
  } catch {
    // Offline, blocked, or no such file. The branch is a working answer.
  }

  sessionStorage.setItem(KEY, DEFAULT_REF ?? '')
}

/**
 * The git ref for what someone typed.
 *
 * A bare `1.2.0` means the tag `v1.2.0` — that is how versions are written in
 * this project and how anyone would type one from a changelog heading. Anything
 * else is passed through untouched, which is what makes a branch name work with
 * no extra syntax.
 */
function refFor(v) {
  return /^\d+\.\d+\.\d+/.test(v) ? `v${v}` : v
}

/**
 * The sidebar for whatever version is being read.
 *
 * **The point of the file.** Before it, the sidebar was always this shell's —
 * so reading `?v=0.1.0-beta.5` listed `reference/config`, which had not been
 * written yet, and clicking it produced an apology. The list now comes from the
 * ref itself, so a version's sidebar describes that version.
 *
 * A ref older than `pages.json` gets this shell's copy instead. That is the
 * honest fallback: the alternative is no sidebar at all on every tag cut before
 * today, and a navigable site listing one or two pages that are not there beats
 * an unnavigable one. Those still land on the "not in this version" page, which
 * is why it survives this change rather than being replaced by it.
 *
 * Any failure falls back the same way — 404, a network error, a `pages.json`
 * that does not parse. A malformed file at some tag is not a reason to serve a
 * broken site today.
 */
async function loadNav() {
  const ref = effectiveRef()

  if (ref) {
    try {
      const res = await fetch(`${RAW}/${encodeURIComponent(refFor(ref))}/docs/pages.json`)
      if (res.ok) return await res.json()
    } catch {
      // Fall through to this shell's copy.
    }
  }

  try {
    return await (await fetch('pages.json')).json()
  } catch {
    // Served from somewhere `pages.json` is missing. The site still routes and
    // still searches nothing; an empty sidebar is better than a dead page.
    return []
  }
}

/* ----------------------------------------------------------------- changelog
   A fixed row in every site this shell renders, rather than a page each project
   writes. The content is the releases, which cutver already produces, so a
   project that has to author its own changelog page has been given a worse copy
   of a file it already publishes.

   **The bodies come from the tags, not from `CHANGELOG.md`.** For a project
   with a summariser configured the two differ: `cutver notes` takes the
   changelog section for a tag and rewrites it, and *that* is what lands on the
   release. The file keeps the raw compiled sections. So the release body is the
   published prose and the file is its source.

   **One request, and usually not even that.** `/releases?per_page=100` returns
   every release with its body inline — this is not a request per tag. The
   result is then cached against the newest version out of `versions.json`,
   which is a local file the page can read for free, so a returning visitor
   makes no API call at all until a release actually appears. That turns
   GitHub's 60-per-hour-per-IP limit from a cost paid on every page load into
   one paid once per release, which matters because that quota is shared by
   every reader behind one corporate NAT.

   **And it falls back to the file.** Rate-limited, offline, blocked, or a
   repository whose releases carry no bodies: `CHANGELOG.md` over raw is
   CDN-cached and effectively unlimited, so the page degrades to the same words
   rather than to an empty panel.                                             */
const RELEASES_API = `https://api.github.com/repos/${REPO.replace(/^https?:\/\/github\.com\//, '')}/releases?per_page=100`
const CHANGELOG_KEY = 'bakery-docs-changelog'

/**
 * Bumped whenever this file changes how a release is turned into markdown, or
 * whenever the bodies upstream are rewritten without a release being cut.
 *
 * The version alone is not enough to invalidate with. A shell update that
 * changes the rendering leaves every returning reader on the markdown the old
 * one produced, keyed to a version that has not moved and so never refetched.
 * Found exactly that way: stripping the presentational tags out of the bodies
 * changed nothing on screen until storage was cleared by hand.
 */
const CHANGELOG_FORMAT = 3

/**
 * The newest release this browser has ever seen, and the validator that keeps
 * it current.
 *
 * `versions.json` cannot carry a release cut on another branch. The file is
 * written by the branch that releases and the site is served from one branch —
 * so a channel shipping thirty alphas leaves the deployed copy insisting the
 * stable line is all there is, the picker never offers them, and the changelog
 * cache, keyed on that same file, never notices a reason to refresh.
 *
 * The releases API sees every branch's tags at once, and a conditional request
 * makes asking affordable: GitHub does not count a `304 Not Modified` against
 * the rate limit, so revalidating with the stored `ETag` is free every time
 * nothing has changed. The request only costs quota at the moment a release
 * has actually appeared — once per release, not per visitor.
 */
const RELEASES_ETAG = 'bakery-docs-rel-etag'
const NEWEST_SEEN = 'bakery-docs-newest'

/**
 * The versions the API reported, stored beside the ETag they came with.
 *
 * Stored because of what a `304` means: "what you have is current", where what
 * we have is this list — not the file. The first build kept the merged list in
 * session state that the next boot overwrote from `versions.json`, so a warm
 * reload revalidated, was told nothing changed, and painted the stale file
 * anyway: the top-up only survived one page load.
 */
const RELEASES_SEEN = 'bakery-docs-rel-versions'

/** The file's list and the API's, as the picker should show them. */
function mergedVersions(fileVersions) {
  try {
    const seen = JSON.parse(localStorage.getItem(RELEASES_SEEN) || '[]')
    return [...new Set([...seen, ...fileVersions])]
  } catch {
    return fileVersions
  }
}

/** The newest version, for the cache key. Local first, then what the API said. */
async function newestVersion() {
  const seen = localStorage.getItem(NEWEST_SEEN)
  if (seen) return seen
  try {
    const doc = await (await fetch('versions.json')).json()
    return (Array.isArray(doc.versions) && doc.versions[0]) || doc.latest || ''
  } catch {
    return ''
  }
}

/**
 * Releases into one markdown document, so the page reuses the renderer every
 * other page uses — and gets the on-page contents, the anchors and the search
 * index out of it for nothing.
 *
 * The date is its own emphasised line rather than part of the heading: the
 * heading becomes a table-of-contents entry and an anchor, and `2.3.0` is what
 * somebody links to and searches for, not `2.3.0 — 2026-08-18`.
 */
function releasesToMarkdown(list) {
  const entries = list
    .filter(r => !r.draft)
    .map(r => {
      const version = String(r.tag_name || r.name || '').replace(/^v/, '')
      const when = r.published_at ? r.published_at.slice(0, 10) : ''
      // The renderer does no inline HTML, and release notes written for
      // GitHub contain a little of it — cutver puts its own diff line in a
      // `<sub>`. Escaped, that reaches the reader as literal angle brackets,
      // which is worse than either rendering it or dropping it. The tags go
      // and their text stays.
      const body = String(r.body || '')
        .replace(/<\/?(sub|sup|br|kbd)\b[^>]*>/gi, '')
        .trim()
      return `## ${version}\n\n${when ? `*${when}*\n\n` : ''}${body || '*No notes for this release.*'}`
    })
  return entries.length ? `# Changelog\n\n${entries.join('\n\n')}` : ''
}

async function changelogMarkdown() {
  const newest = await newestVersion()

  // Keyed on the version rather than on a clock. A TTL would re-fetch on a
  // schedule that has nothing to do with when the content changes.
  try {
    const hit = JSON.parse(localStorage.getItem(CHANGELOG_KEY) || 'null')
    if (hit && hit.v === newest && hit.f === CHANGELOG_FORMAT && hit.md && newest) {
      return hit.md
    }
  } catch {
    // A malformed entry is not worth a broken page; fetch instead.
  }

  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (res.ok) {
      const md = releasesToMarkdown(await res.json())
      if (md) {
        // Only cached against a version. Without one there is nothing to
        // invalidate against, and a cache that never expires is worse than none.
        if (newest) {
          try {
            localStorage.setItem(CHANGELOG_KEY, JSON.stringify({ v: newest, f: CHANGELOG_FORMAT, md }))
          } catch {
            // Storage full or disabled. The page works; the next visit refetches.
          }
        }
        return md
      }
    }
  } catch {
    // Offline or blocked. The file below is the answer either way.
  }

  const ref = effectiveRef()
  const at = ref ? encodeURIComponent(refFor(ref)) : 'HEAD'
  try {
    const res = await fetch(`${RAW}/${at}/CHANGELOG.md`)
    if (res.ok) return await res.text()
  } catch {
    // Nothing left to try.
  }

  return '# Changelog\n\nNo releases yet.'
}

/**
 * Top the version list up from the releases API, when it has actually moved.
 *
 * Runs once per page load, after the picker has painted from `versions.json`,
 * and does nothing visible unless the API knows releases the file does not —
 * which is exactly the state a channel branch puts the deployed site in. On a
 * `304` it cost nothing, changed nothing, and the file's answer stands.
 *
 * On a `200` three things update from the one response: the picker gains the
 * missing versions, the changelog cache is rewritten from the same bytes so
 * that page is fresh without a second request, and the newest release is
 * remembered as the validator the caches key on.
 *
 * Failures change nothing. Offline, blocked, or rate-limited by sixty cold
 * visitors behind one NAT, the site keeps saying what `versions.json` says —
 * which is true, just not complete.
 */
async function refreshReleases(serving, fileVersions) {
  try {
    const headers = { Accept: 'application/vnd.github+json' }
    // The validator is only sent while the data it validates is still here. A
    // 304 means "what you stored is current" — with the list missing (evicted,
    // or stored by a build that kept the ETag alone), that answer pins the
    // picker to the stale file until the ETag happens to change upstream.
    const etag = localStorage.getItem(RELEASES_ETAG)
    if (etag && localStorage.getItem(RELEASES_SEEN)) {
      headers['If-None-Match'] = etag
    }

    const res = await fetch(RELEASES_API, { headers })
    if (res.status === 304 || !res.ok) return

    const list = (await res.json()).filter(r => !r.draft)
    const fresh = list
      .map(r => String(r.tag_name || '').replace(/^v/, ''))
      .filter(Boolean)
    if (!fresh.length) return

    // The API lists by creation date, newest first, which is the right order
    // for "what appeared since": a prerelease cut this morning belongs above
    // the stable from last week whatever semver thinks of it. The file's list
    // follows, minus what the API already said.
    localStorage.setItem(RELEASES_SEEN, JSON.stringify(fresh))
    const merged = mergedVersions(fileVersions)

    const tag = res.headers.get('ETag')
    if (tag) localStorage.setItem(RELEASES_ETAG, tag)
    localStorage.setItem(NEWEST_SEEN, merged[0])

    // The same bytes are the changelog, so cache them while they are here —
    // otherwise the changelog page would spend a second, counted request on
    // what this one already carried.
    const md = releasesToMarkdown(list)
    if (md) {
      localStorage.setItem(
        CHANGELOG_KEY,
        JSON.stringify({ v: merged[0], f: CHANGELOG_FORMAT, md }),
      )
    }

    fillPicker(serving || merged[0], merged)
  } catch {
    // The file's answer stands.
  }
}

/**
 * The changelog, a few releases at a time.
 *
 * Rendering every release on arrival is fine at twenty-seven and not fine at
 * two hundred: the markdown is parsed for all of them, the HTML is built for
 * all of them, and the whole lot is inserted before the first line is on
 * screen. The cost is paid up front, by every reader, for content most of them
 * will never scroll to.
 *
 * So the document is split per version and rendered a batch at a time. The
 * split runs on the compiled markdown rather than on the API response, which
 * means the `CHANGELOG.md` fallback gets the same treatment for free — it is
 * the same shape, one `##` per version.
 *
 * **The contents panel still lists every version.** It is built from the split,
 * not from the headings in the DOM, so navigation is complete from the first
 * paint while the content behind it is not. That is the whole point: the list
 * is small and cheap, the bodies are neither.
 */
const CHANGELOG_BATCH = 6

/** One chunk per version, plus whatever preceded the first heading. */
function splitChangelog(md) {
  const parts = md.replace(/\r\n/g, '\n').split(/(?=^## )/m)
  const head = parts.length && !parts[0].startsWith('## ') ? parts.shift() : ''
  return {
    head,
    entries: parts.map(chunk => ({
      version: ((/^##\s+(.+)$/m.exec(chunk) || [])[1] || '').trim(),
      md: chunk,
    })),
  }
}

/** Disconnects the observer from a previous visit, so it stops on navigation. */
let stopFeed = null

function startChangelogFeed(content, entries, page, anchor) {
  stopFeed?.()

  const sentinel = document.createElement('div')
  sentinel.className = 'cl-more'
  content.appendChild(sentinel)

  let shown = 0
  let observer = null

  const more = () => {
    const slice = entries.slice(shown, shown + CHANGELOG_BATCH)
    if (!slice.length) return false
    // Inserted before the sentinel rather than replacing the container, so
    // nothing already on screen is re-parsed and the scroll position holds.
    sentinel.insertAdjacentHTML(
      'beforebegin',
      slice.map(e => render(e.md, page, versionSlug(e.version)).html).join(''),
    )
    shown += slice.length
    if (shown >= entries.length) {
      observer?.disconnect()
      sentinel.remove()
    }
    return true
  }

  const REACH = 800

  /**
   * Keep going while the sentinel is still within reach, not once per event.
   *
   * The observer reports *changes* in intersection, so one batch per crossing.
   * A reader who jumps to the end — End, a long fling, a scroll restored on
   * reload — lands past everything rendered, gets a single batch, and then has
   * to nudge the page to ask for the next. Filling until the sentinel is out of
   * range makes the jump behave like the scroll.
   */
  const fill = () => {
    let guard = 0
    while (guard++ < 50) {
      if (sentinel.getBoundingClientRect().top > innerHeight + REACH) return
      if (!more()) return
    }
  }

  // A margin, so the next batch is built before its space is reached rather
  // than after — the reader should never arrive at a gap.
  observer = new IntersectionObserver(
    hits => { if (hits.some(h => h.isIntersecting)) fill() },
    { rootMargin: `${REACH}px 0px` },
  )
  observer.observe(sentinel)

  more()

  // A link to a version that has not been rendered yet is still a link that has
  // to work — every entry in the contents panel is one of those on arrival.
  // Render on until it exists, then let the caller scroll to it.
  if (anchor) {
    let guard = 0
    while (!document.getElementById(anchor) && guard++ < 500 && more()) {
      /* keep going */
    }
  }

  stopFeed = () => observer?.disconnect()
}

/* ------------------------------------------------------------------- routing */
const cache = new Map()
async function load(page) {
  // Not a file in `docs/`, so it never reaches the fetch below. Branching
  // here rather than in `route()` is what puts it in the search index and in
  // prev/next as well as on screen.
  if (page === 'CHANGELOG') return changelogMarkdown()

  const ref = effectiveRef()
  const key = `${ref ?? ''}:${page}`

  if (!cache.has(key)) {
    const url = ref
      ? `${RAW}/${encodeURIComponent(refFor(ref))}/docs/${page}.md`
      : `${page}.md`
    const res = await fetch(url)
    if (!res.ok) throw new Error(String(res.status))
    cache.set(key, await res.text())
  }
  return cache.get(key)
}

/* ------------------------------------------------------------------ the URL
   `?/guides/commits`, not `#/guides/commits`.

   **A fragment never reaches the server, so it cannot be a page.** Everything
   after `#` is stripped before the request goes out: every route on this site
   was one URL as far as a crawler was concerned, and only the front page could
   ever be indexed. A query string is part of the URL, so `?/a` and `?/b` are
   two of them.

   A query rather than a real path because of where this is hosted. GitHub
   Pages serves a file per path, so `/guides/commits` would need one written for
   every page and a 404 for anything else; `?/guides/commits` has the path `/`,
   which is `index.html`, answered 200 without a single extra file.

   The shape is deliberate on two counts. It differs from the old form by one
   character, so the redirect below is exact and every existing link survives.
   And it leaves the fragment free for what a fragment is actually for — an
   anchor within the page — so `?/guides/commits#writing-them` behaves the way
   that URL looks like it should.

   `v` keeps its own key alongside: `?/guides/commits&v=2.1.0` is a query with
   two of them, and `URLSearchParams` still finds `v` without being told about
   the first.                                                                 */

/** The page and the in-page anchor, read from the two halves of the URL. */
function currentRoute() {
  const first = location.search.replace(/^\?/, '').split('&')[0] || ''
  const path = first.startsWith('/') ? decodeURIComponent(first.slice(1)) : ''
  return {
    page: path ? path.replace(/\/$/, '') : 'README',
    anchor: location.hash.replace(/^#/, '') || undefined,
  }
}

/**
 * A link to a page on this site, carrying the pinned version through.
 *
 * Every internal link is built here. Threading `?v=` by hand at each site is
 * what the old form got for free — changing a fragment cannot touch the query —
 * and losing it silently drops the reader back onto the current release
 * mid-navigation, which is the one bug this scheme could plausibly introduce.
 */
function routeHref(page, anchor) {
  const v = requestedRef()
  const path = page === 'README' ? '' : page
  const query = `?/${path}${v ? `&v=${encodeURIComponent(v)}` : ''}`
  return `${query}${anchor ? `#${anchor}` : ''}`
}

/**
 * Send an old `#/page` link to its `?/page` equivalent, once, on arrival.
 *
 * Every README, every release body and every link anyone has bookmarked uses
 * the fragment form. `replaceState` rather than assigning: the reader followed
 * one link and should be able to leave with one press of Back.
 */
function migrateHashUrl() {
  const m = /^#\/(.*)$/.exec(location.hash)
  if (!m) return
  const [path, anchor] = m[1].split('#')
  history.replaceState(null, '', routeHref(path || 'README', anchor))
}

/** This page with no version pinned — what "read the current release" means. */
function currentHrefWithoutVersion() {
  const { page, anchor } = currentRoute()
  return `?/${page === 'README' ? '' : page}${anchor ? `#${anchor}` : ''}`
}

/** The same page, at another version. The picker changes one of the two keys. */
function versionHref(v) {
  const { page, anchor } = currentRoute()
  const path = page === 'README' ? '' : page
  return `${location.pathname}?/${path}${v ? `&v=${encodeURIComponent(v)}` : ''}${anchor ? `#${anchor}` : ''}`
}

/** Move to an anchor without rebuilding the page it is already on. */
function goToAnchor() {
  const { anchor } = currentRoute()
  if (anchor) document.getElementById(anchor)?.scrollIntoView()
  else scrollTo(0, 0)
  syncAside()
}

/**
 * Follow an internal link without reloading.
 *
 * A query change is a navigation as far as the browser is concerned, so
 * `<a href="?/x">` would fetch the page again and throw away the rendered
 * markdown, the search index and the changelog batches. The modifier keys are
 * left alone deliberately: ctrl-click and middle-click open a tab, and a
 * handler that swallows them breaks something readers rely on.
 */
addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

  const link = event.target.closest?.('a')
  if (!link || link.target === '_blank' || link.hasAttribute('download')) return

  const href = link.getAttribute('href') || ''
  if (!href.startsWith('?/')) return

  event.preventDefault()
  // **The ref counts as much as the page.** Comparing pages alone broke the one
  // link that changes only the version: "read it in the current release" points
  // at the page being read, minus `?v=`, so the page matched, the fragment was
  // scrolled to instead of the content being rebuilt, and clicking it did
  // visibly nothing — the URL lost its version and the screen kept the old ref's
  // markdown, including the banner offering the link again.
  const before = routeKey()
  history.pushState(null, '', href)
  if (routeKey() === before) goToAnchor()
  else route()
})

/** What has to match for a click to be a move within the same rendered page. */
function routeKey() {
  return JSON.stringify([currentRoute().page, requestedRef()])
}

addEventListener('popstate', () => route())

async function route() {
  const { page, anchor } = currentRoute()
  const content = document.getElementById('content')
  let src
  try {
    src = await load(page)
  } catch {
    // Reachable in two ways, and both are ordinary. A ref that predates
    // `pages.json` borrows this shell's sidebar, which lists pages it does not
    // have; and a link typed or bookmarked from a newer version does not care
    // what the sidebar says. Saying "no page" is true and useless — saying
    // which version was asked is the answer.
    const missing = requestedRef()
    content.innerHTML = missing
      ? `<h1>Not in ${esc(refFor(missing))}</h1>
         <p>There is no <code>${esc(page)}.md</code> at <code>${esc(refFor(missing))}</code> — the
            page may not have existed yet, or may have been named something else.</p>
         <p><a href="${currentHrefWithoutVersion()}">Read it in the current release</a>.</p>`
      : `<h1>Not found</h1><p>No page at <code>${esc(page)}.md</code>.</p><p><a href="${routeHref('README')}">Back to the introduction</a></p>`
    document.getElementById('aside').innerHTML = ''
    document.getElementById('pager').innerHTML = ''
    return
  }

  const isLog = page === 'CHANGELOG'
  const split = isLog ? splitChangelog(src) : null

  // The changelog renders its heading only; the releases arrive in batches
  // below, and its contents come from the split rather than from the DOM.
  const { html, toc: headings } = render(isLog ? split.head : src, page)
  let toc = isLog
    ? split.entries.map(e => ({ lvl: 2, text: e.version, id: versionSlug(e.version) }))
    : headings
  // Said on every page, not once on entry. Someone arriving from a search
  // result lands mid-site, and a banner they never saw is a banner that did not
  // work — this is the state where every instruction on screen may be wrong for
  // the version they are actually running.
  const ref = requestedRef()
  content.innerHTML = ref
    ? `<div class="oldver">Reading the docs at <code>${esc(refFor(ref))}</code>.
         <a href="${currentHrefWithoutVersion()}">Switch to the current release</a>.</div>${html}`
    : html
  // One class, so the release entries can be styled without the markdown
  // renderer having to emit anything it does not emit for every other page.
  content.classList.toggle('changelog', page === 'CHANGELOG')
  // After the heading is in the DOM, since the first batch appends to it.
  if (isLog) startChangelogFeed(content, split.entries, page, anchor)
  document.title = `${content.querySelector('h1')?.textContent || 'Bakery'} | Bakery`

  // The title is the one link in the static shell rather than in generated
  // markup, so it is the one `routeHref` never got to build. Left as written it
  // sends a reader pinned to an old version back to the current release without
  // saying so — the same silent unpinning the query-string scheme exists to
  // prevent everywhere else.
  document.querySelector('.brand')?.setAttribute('href', routeHref('README'))

  // on-page contents
  const aside = document.getElementById('aside')

  aside.innerHTML = toc.length > 2
    ? `<div class="aside-title">On this page</div>${toc.map(t =>
        `<a href="${routeHref(page, t.id)}" class="${t.lvl === 3 ? 'lvl3' : ''}" data-id="${t.id}">${esc(t.text)}</a>`).join('')}`
    : ''

  // sidebar active state
  document.querySelectorAll('.sb-link').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page)
  })

  // prev / next
  const idx = FLAT.findIndex(([p]) => p === page)
  const prev = idx > 0 ? FLAT[idx - 1] : null
  const next = idx >= 0 && idx < FLAT.length - 1 ? FLAT[idx + 1] : null
  document.getElementById('pager').innerHTML =
    (prev || next ? `<div class="pager">
      ${prev ? `<a href="${routeHref(prev[0])}"><span class="p-dir">Previous</span>${prev[1]}</a>` : '<span style="flex:1"></span>'}
      ${next ? `<a class="next" href="${routeHref(next[0])}"><span class="p-dir">Next</span>${next[1]}</a>` : '<span style="flex:1"></span>'}
    </div>` : '') +
    // The changelog has no source file to open — it is the releases, compiled
    // here. Offering to edit `docs/CHANGELOG.md` would send a reader who wanted
    // to fix a typo to GitHub's create-a-file screen for a path the site does
    // not read, and the change would never appear.
    (page === 'CHANGELOG'
      ? ''
      : `<p class="edit-link"><a href="${REPO}/edit/main/docs/${page}.md" target="_blank" rel="noopener">Edit this page on GitHub</a></p>`)

  document.body.classList.remove('menu-open')

  if (anchor) {
    // The element exists only after the innerHTML above, so this cannot move up.
    requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView())
  } else {
    scrollTo(0, 0)
  }
  syncAside()
}

/* highlight the on-page-contents entry for whatever heading is in view */
function syncAside() {
  const links = [...document.querySelectorAll('.aside a')]
  if (!links.length) return
  let active = links[0]
  for (const link of links) {
    const el = document.getElementById(link.dataset.id)
    if (el && el.getBoundingClientRect().top < 140) active = link
  }
  links.forEach(l => {
    l.classList.toggle('active', l === active)
  })

  keepVisible(active)
  markPanelFade(links[0].closest('.aside'))
}

/**
 * Scroll the contents panel so the entry it just highlighted is in it.
 *
 * The panel is its own scroll box — `overflow-y: auto` under a `max-height` —
 * so on a long page the highlight moves out of view and the reader is left
 * looking at a list of headings with no indication of where they are. Short
 * pages never showed it: the list fits, nothing scrolls, and the bug does not
 * exist. The changelog, at one entry per release, does not fit.
 *
 * **Only when the entry changes.** Nudging on every scroll event would fight a
 * reader who has scrolled this panel deliberately to look somewhere else, and
 * would do it sixty times a second.
 *
 * Adjusting `scrollTop` rather than calling `scrollIntoView`: that moves every
 * scrollable ancestor, so it would drag the page itself to bring an entry into
 * view — the reader would find themselves somewhere they did not navigate to,
 * which then picks a different heading, which scrolls again.
 */
/**
 * Fade the panel's bottom edge while there is more of it below.
 *
 * No selector can ask whether an element overflows, so the class is set here.
 * Dropped as soon as the end is reached, because a fade that never lifts stops
 * meaning "there is more" and just dims the last entry.
 */
function markPanelFade(panel) {
  if (!panel) return
  const more = panel.scrollTop + panel.clientHeight < panel.scrollHeight - 2
  panel.classList.toggle('more-below', more)
}

let asideActive = null
function keepVisible(link) {
  if (link === asideActive) return
  asideActive = link

  const panel = link.closest('.aside')
  if (!panel || panel.scrollHeight <= panel.clientHeight + 1) return

  const a = link.getBoundingClientRect()
  const p = panel.getBoundingClientRect()
  // The heading is sticky and opaque, so the top of the box is not where an
  // entry becomes visible — anything above its lower edge is behind it.
  const head = panel.querySelector('.aside-title')
  const top = head ? head.getBoundingClientRect().bottom : p.top
  const margin = 8

  if (a.top < top + margin) panel.scrollTop -= top + margin - a.top
  else if (a.bottom > p.bottom - margin) panel.scrollTop += a.bottom - (p.bottom - margin)
}

/* --------------------------------------------------------------------- boot */
function renderSidebar() {
  document.getElementById('sidebar').innerHTML = NAV.map(group =>
    `<div class="sb-group"><div class="sb-title">${esc(group.title)}</div>` +
    group.items.map(([p, label]) =>
      `<a class="sb-link" data-page="${esc(p)}" href="${esc(routeHref(p))}">${esc(label)}</a>`).join('') +
    '</div>').join('') +
    '<div class="sb-group">' +
    `<a class="sb-link" data-page="CHANGELOG" href="${routeHref('CHANGELOG')}">Changelog</a>` +
    '</div>'
}

const root = document.documentElement
const stored = localStorage.getItem('bakery-theme')
if (stored) root.dataset.theme = stored
document.getElementById('theme-btn').onclick = () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  const now = root.dataset.theme || (dark ? 'dark' : 'light')
  const next = now === 'dark' ? 'light' : 'dark'
  root.dataset.theme = next
  localStorage.setItem('bakery-theme', next)
}
document.getElementById('menu-btn').onclick = () => document.body.classList.toggle('menu-open')
document.getElementById('scrim').onclick = () => document.body.classList.remove('menu-open')

/**
 * Collapsed search, for the narrow layout where the field does not fit.
 *
 * `search-open` is only consulted by the mobile media query, so leaving it set
 * when the viewport grows is harmless — the field is visible at that width
 * regardless, and forcing it closed on resize would clear a query mid-typing on
 * a phone that merely rotated.
 */
const searchToggle = document.getElementById('search-toggle')
const searchClose = document.getElementById('search-close')

function openSearch() {
  document.body.classList.add('search-open')
  searchToggle.setAttribute('aria-expanded', 'true')
  box.focus()
}
function closeSearch() {
  document.body.classList.remove('search-open')
  searchToggle.setAttribute('aria-expanded', 'false')
  box.value = ''
  results.classList.remove('open')
  // Must blur, not just hide. The field keeps focus after it goes
  // `display: none`, which leaves keystrokes going into an invisible input and
  // makes the `/` shortcut a no-op — its guard sees the box already focused and
  // returns without expanding anything.
  box.blur()
}
searchToggle.onclick = openSearch
searchClose.onclick = closeSearch

document.addEventListener('click', e => {
  const btn = e.target.closest('.copy-btn')
  if (!btn) return
  navigator.clipboard.writeText(btn.parentElement.querySelector('code').innerText)
  btn.textContent = 'Copied'
  setTimeout(() => { btn.textContent = 'Copy' }, 1400)
})

/* search — the index is built on first use, not on load, so the page paints
   without waiting on 28 fetches nobody may want. */
let index = null
const box = document.getElementById('search')
const results = document.getElementById('results')

/**
 * Markdown source reduced to the words a reader would recognise.
 *
 * The index stores prose, not syntax. Without this a snippet reads
 * `- [CLI](reference/cli.md) - [Architecture](reference/arch…` — the link
 * targets crowd out the sentence, and a search for a word in a URL matches text
 * nobody can see on the page.
 */
function plain(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>|]/g, '')
    .replace(/^\s*[-+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function buildIndex() {
  if (index) return index
  index = []
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: search index build — one branch per field weight
  await Promise.all(FLAT.map(async ([page, label]) => {
    let src
    try { src = await load(page) } catch { return }
    let section = label, body = [], inFence = false
    for (const line of src.split('\n')) {
      // Track the fence rather than skipping only the ``` line itself. The old
      // test let every line *inside* a code block into the index, so a snippet
      // could be a fragment of someone's example mid-identifier.
      if (/^```/.test(line)) { inFence = !inFence; continue }
      if (inFence) continue
      const h = /^(#{1,4})\s+(.*)$/.exec(line)
      if (h) {
        if (body.length) index.push({ page, label, section, id: slug(section), text: body.join(' ') })
        section = h[2].replace(/`/g, '').trim()
        body = []
      } else if (line.trim()) {
        const text = plain(line)
        if (text) body.push(text)
      }
    }
    if (body.length) index.push({ page, label, section, id: slug(section), text: body.join(' ') })
  }))
  return index
}

let selected = -1
async function search() {
  const q = box.value.trim().toLowerCase()
  if (q.length < 2) { results.classList.remove('open'); return }
  const idx = await buildIndex()
  const terms = q.split(/\s+/)
  const hits = idx.map(e => {
    const hay = `${e.section} ${e.text}`.toLowerCase()
    if (!terms.every(t => hay.includes(t))) return null
    let score = 0
    for (const t of terms) {
      if (e.section.toLowerCase().includes(t)) score += 12
      if (e.label.toLowerCase().includes(t)) score += 6
      score += Math.min(4, (hay.split(t).length - 1))
    }
    return { e, score }
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12)

  selected = -1
  results.innerHTML = hits.length
    ? hits.map(({ e }) => {
        // Window around the first hit, then advance to a word boundary —
        // slicing at a fixed offset otherwise opens the snippet mid-word
        // ("ation-supplied authorization predicate"), which reads as corruption.
        const pos = e.text.toLowerCase().indexOf(terms[0])
        const from = pos >= 0 ? Math.max(0, pos - 40) : 0
        let snip = e.text.slice(from, from + 130)
        if (from > 0) snip = `…${snip.slice(snip.indexOf(' ') + 1)}`
        return `<a href="${routeHref(e.page, e.id)}"><span class="r-crumb">${esc(e.label)}</span>` +
          `<span class="r-title">${esc(e.section)}</span>` +
          `<span class="r-snip">${esc(snip)}…</span></a>`
      }).join('')
    : '<div class="empty">No matches</div>'
  results.classList.add('open')
}

box.addEventListener('input', search)
box.addEventListener('keydown', e => {
  const links = [...results.querySelectorAll('a')]
  if (e.key === 'Escape') { box.blur(); closeSearch(); return }
  if (!links.length) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length
    links.forEach((l, i) => {
      l.classList.toggle('sel', i === selected)
    })
    links[selected].scrollIntoView({ block: 'nearest' })
  } else if (e.key === 'Enter' && selected >= 0) {
    links[selected].click()
    box.blur(); closeSearch()
  }
})
document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) results.classList.remove('open')
})
results.addEventListener('click', closeSearch)
addEventListener('keydown', e => {
  // `/` has to open the collapsed field too, or the shortcut focuses an input
  // that is display:none and silently does nothing.
  if (e.key === '/' && document.activeElement !== box) { e.preventDefault(); openSearch() }
})

/* ------------------------------------------------------------- version badge
   Read from `versions.json`, which the release workflow writes from the tags.

   A number baked into a page nobody re-reads goes stale silently, so this was
   fetched from the npm registry: it always knows, and it answers "what would I
   get if I installed this right now".

   The tags are the better source, and not only because they are what `?v=`
   resolves against. A registry answer ties the badge to having published a
   package at all — which a Rust workspace shipping binaries has not — and npm
   pins `latest` on a package's first publish whatever `--tag` said, so a
   project that opened with a prerelease shows a stable release it left behind.
   Reading the tags at page load would mean GitHub's API and its 60 requests an
   hour per IP, shared by every reader behind one NAT.

   Committing them costs neither. The workflow already knows every tag at the
   moment it writes one, so it writes the list too — the same trick as
   `pages.json`, and it needs no build step for this site, which is still served
   straight out of `docs/`.

   Failure hides the badge rather than showing a guess. Offline, blocked by a
   corporate proxy, or a missing file are all states where "no version" is true
   and "v4" is a lie.                                                         */
/**
 * The version picker, and why it changes `location.search` rather than routing.
 *
 * Setting the query reloads the page, which is exactly what is wanted: the
 * markdown cache is keyed by ref, the banner is rendered per page, and a reload
 * makes both correct with no state to reconcile. A picker is used once or twice
 * in a session — spending a reload to avoid a class of stale-state bug is a
 * good trade.
 */
function fillPicker(latest, versions = []) {
  const sel = document.getElementById('verpick')
  if (!sel || !latest) return

  const current = requestedRef()

  // **The button's label is written, not mirrored.** `<selectedcontent>` is the
  // spec's way to clone the selected option into the button, and it stayed
  // empty here — injecting the whole control with `innerHTML` gives it nothing
  // to react to — which collapsed the badge to a 24px stub showing only its
  // arrow. This control re-renders on load and navigates on change, so it never
  // needs to mirror anything live; the label is just set.
  const label = current ? (versions.includes(current) ? `v${current}` : current) : `v${latest}`

  // The empty value is the live docs, labelled with the version they are —
  // "latest" as a word tells a reader nothing they can check, and this control
  // is also the version badge. Selecting it clears `?v=` and goes home.
  const options = [
    `<button>${esc(label)}</button>`,
    `<option value=""${current ? '' : ' selected'}>v${esc(latest)}</option>`,
    // **Not reversed.** The packument this used to read returns versions in
    // publish order, so the list arrived oldest-first and had to be flipped.
    // `versions.json` is written newest-first — sorted properly, since git's
    // own `-v:refname` puts a prerelease above the release it precedes — and
    // flipping it again put v2.2.0 at the top with every beta climbing under it.
    ...versions
      .filter(v => v !== latest)
      .map(v => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>v${esc(v)}</option>`),
  ]

  // A ref typed by hand — a branch, or a tag with no published package — keeps
  // its own entry rather than silently resetting the control to the latest
  // version, which would tell the reader they are somewhere they are not.
  if (current && !versions.includes(current)) {
    options.splice(2, 0, `<option value="${esc(current)}" selected>${esc(current)}</option>`)
  }

  sel.innerHTML = options.join('')

  // **Set explicitly, because a browser restores a select across a reload.**
  // Form-state restoration puts back whatever index was chosen last time and
  // wins over the `selected` attribute — so after picking 1.1.1 and coming
  // back, the control claimed 1.1.1 while the page showed the latest docs. The
  // query string is the only thing that decides what is being read; the control
  // is told, not asked.
  sel.value = current && [...sel.options].some(o => o.value === current) ? current : ''
  sel.hidden = false

  sel.onchange = () => {
    // A whole URL rather than `location.search`, which leaves a bare `?` on the
    // way back to the latest docs and reloads twice as a result.
    const v = sel.value
    location.assign(versionHref(v))
  }
}

;(async () => {
  const CACHE = 'bakery-docs-version'
  const LIST = 'bakery-docs-versions'

  // Session-cached so moving between pages does not re-fetch, and so the
  // control is not blank for a round trip on every navigation.
  const cached = sessionStorage.getItem(CACHE)
  if (cached) {
    fillPicker(cached, JSON.parse(sessionStorage.getItem(LIST) || '[]'))
  }

  try {
    // **The tags, committed rather than asked for.**
    //
    // The tags are what `?v=` resolves against, so they are the honest source
    // — but reading them at page load means GitHub's tags API, which allows 60
    // unauthenticated requests an hour *per IP*, shared by every reader behind
    // one corporate NAT. The registry packument had no such limit and was the
    // first answer here; it also tied a docs site to having published a
    // package at all, which a Rust workspace releasing binaries has not.
    //
    // So the release workflow writes this file when it writes the tag. Same
    // trick as `pages.json`: a fact the build already knows, committed, rather
    // than a lookup every reader pays for. No API, no rate limit, no registry,
    // and it works identically for a repository that publishes nothing.
    const res = await fetch('versions.json')
    if (!res.ok) return
    const doc = await res.json()

    // Newest tag, prerelease or not. A project living on `2.0.0-alpha.9` should
    // say so rather than showing a stable release it left behind — which is the
    // case npm's `latest` gets wrong, since it is pinned on first publish
    // whatever `--tag` said.
    const version = doc.latest
    // Guard the shape as well as the request: an error page that happens to
    // parse as JSON would otherwise put `vundefined` in the header.
    if (typeof version !== 'string' || !version) return
    const versions = Array.isArray(doc.versions) ? doc.versions : []

    // **The badge names what is being served, not what was hoped for.**
    // `latest` is the newest stable, and that is the default *when its tag can
    // serve itself* — a tag predating `pages.json` cannot, so the default falls
    // back to the branch. Labelling that fallback `v1.2.3` while showing the
    // branch's unreleased pages is the disagreement the default was meant to
    // remove, so the label follows the ref that actually won.
    await resolveDefaultRef()
    const serving = DEFAULT_REF ?? versions[0] ?? version

    // Painted with everything already known — the file, topped up with what a
    // previous visit learned from the API. A reload that revalidates to a 304
    // does no repaint, so the paint has to start complete.
    const known = mergedVersions(versions)
    sessionStorage.setItem(CACHE, serving)
    sessionStorage.setItem(LIST, JSON.stringify(known))
    fillPicker(serving, known)

    // After the file has painted, ask whether it is the whole story — a
    // release cut on another branch never reaches this branch's copy.
    refreshReleases(serving, versions)
  } catch {
    // Offline or blocked. The control keeps the cached list, or stays hidden —
    // no version at all is true, and a guessed one is a lie. The API top-up
    // still runs: a missing versions.json is the other state it covers.
    refreshReleases(
      sessionStorage.getItem(CACHE) || '',
      JSON.parse(sessionStorage.getItem(LIST) || '[]'),
    )
  }
})()

// Only anchors live in the fragment now, so a change to it never means a
// different page. Re-rendering on one would throw away the changelog
// batches and scroll the reader back to the top of what they were reading.
addEventListener('hashchange', goToAnchor)
addEventListener('scroll', syncAside, { passive: true })
// The panel scrolls on its own as well as being scrolled by the reader, so the
// fade tracks its own scrollbar rather than only the page.
document.getElementById('aside')?.addEventListener(
  'scroll',
  e => markPanelFade(e.currentTarget),
  { passive: true },
)

// **Awaited before the first route, not raced with it.** `route()` sets the
// sidebar's active link and builds prev/next from `FLAT`; running it against an
// empty nav renders a page with no highlight and no pager, and nothing would
// come back to fix it. One fetch of a local file is not a delay worth a bug.
;(async () => {
  // Before the nav, because the nav is fetched from whatever ref this settles.
  await resolveDefaultRef()
  migrateHashUrl()
  setNav(await loadNav())
  renderSidebar()
  route()
})()
