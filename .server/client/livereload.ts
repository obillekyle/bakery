let needsReload = false
let isDead = false
const logQueue: string[] = []

function getHtmlDifference(htmlA: string, htmlB: string): number {
  const getBigrams = (str: string) => {
    const s = str.replace(/\s+/g, '')
    const bigrams = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.substring(i, i + 2))
    }
    return bigrams
  }

  const setA = getBigrams(htmlA)
  const setB = getBigrams(htmlB)

  const intersection = setA.intersection(setB).size

  const similarity = (2.0 * intersection) / (setA.size + setB.size) || 0
  return (1 - similarity) * 100
}

function replaceNode(current: Node, incoming: Node) {
  if (current.parentNode) {
    current.parentNode.replaceChild(
      document.importNode(incoming, true),
      current,
    )
  }
}

function updateTextOrCommentNode(current: Node, incoming: Node) {
  if (current.nodeValue !== incoming.nodeValue) {
    current.nodeValue = incoming.nodeValue
  }
}

function patchAttributes(curEl: Element, incEl: Element) {
  for (const attr of Array.from(incEl.attributes)) {
    if (curEl.getAttribute(attr.name) !== attr.value) {
      curEl.setAttribute(attr.name, attr.value)
    }
  }
  for (const attr of Array.from(curEl.attributes)) {
    if (!incEl.hasAttribute(attr.name)) {
      curEl.removeAttribute(attr.name)
    }
  }
}

function patchInputFields(curEl: Element, incEl: Element) {
  if (curEl instanceof HTMLInputElement && incEl instanceof HTMLInputElement) {
    if (curEl.value !== incEl.value) {
      curEl.value = incEl.value
    }
    if (curEl.checked !== incEl.checked) {
      curEl.checked = incEl.checked
    }
  } else if (
    curEl instanceof HTMLTextAreaElement &&
    incEl instanceof HTMLTextAreaElement
  ) {
    if (curEl.value !== incEl.value) {
      curEl.value = incEl.value
    }
  } else if (
    curEl instanceof HTMLSelectElement &&
    incEl instanceof HTMLSelectElement
  ) {
    if (curEl.value !== incEl.value) {
      curEl.value = incEl.value
    }
  }
}

function patchChildNodes(curEl: Element, incEl: Element) {
  const curChildren = Array.from(curEl.childNodes)
  const incChildren = Array.from(incEl.childNodes)
  const minLen = Math.min(curChildren.length, incChildren.length)

  for (let i = 0; i < minLen; i++) {
    const curChild = curChildren[i]
    const incChild = incChildren[i]

    if (
      curChild.nodeType === incChild.nodeType &&
      (curChild.nodeType !== Node.ELEMENT_NODE ||
        (curChild as Element).tagName === (incChild as Element).tagName)
    ) {
      patchDOM(curChild, incChild)
    } else {
      if (curChild.parentNode === curEl) {
        curEl.replaceChild(document.importNode(incChild, true), curChild)
      }
    }
  }

  for (let i = minLen; i < curChildren.length; i++) {
    const child = curChildren[i]
    if (child.parentNode === curEl) {
      curEl.removeChild(child)
    }
  }

  for (let i = minLen; i < incChildren.length; i++) {
    curEl.appendChild(document.importNode(incChildren[i], true))
  }
}

function patchElementNode(curEl: Element, incEl: Element) {
  if (curEl.tagName !== incEl.tagName) {
    replaceNode(curEl, incEl)
    return
  }

  patchAttributes(curEl, incEl)
  patchInputFields(curEl, incEl)
  patchChildNodes(curEl, incEl)
}

function patchDOM(current: Node, incoming: Node) {
  if (current.nodeType !== incoming.nodeType) {
    replaceNode(current, incoming)
    return
  }

  if (
    current.nodeType === Node.TEXT_NODE ||
    current.nodeType === Node.COMMENT_NODE
  ) {
    updateTextOrCommentNode(current, incoming)
    return
  }

  if (current.nodeType === Node.ELEMENT_NODE) {
    patchElementNode(current as Element, incoming as Element)
  }
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${location.host}/_livereload`)

  const safeStringify = (val: any): string => {
    try {
      if (typeof val !== 'object' || val === null) return String(val)
      const seen = new WeakSet()
      return JSON.stringify(val, (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]'
          seen.add(value)
        }
        return value
      })
    } catch {
      return Object.prototype.toString.call(val)
    }
  }

  const sendLog = (level: string, args: any[]) => {
    const payload = Array.from(args)
      .map(a => safeStringify(a))
      .join(' ')

    const msg = JSON.stringify({
      type: 'client_log',
      level,
      payload,
      ip: '',
    })

    ws.readyState === WebSocket.OPEN ? ws.send(msg) : logQueue.push(msg)
  }

  const ogLog = console.log,
    ogWarn = console.warn,
    ogErr = console.error
  console.log = (...args) => {
    ogLog(...args)
    sendLog('info', args)
  }
  console.warn = (...args) => {
    ogWarn(...args)
    sendLog('warn', args)
  }
  console.error = (...args) => {
    ogErr(...args)
    sendLog('error', args)
  }

  window.onerror = (m, s, l, c) => sendLog('error', [`${m} at ${s}:${l}:${c}`])
  window.addEventListener('unhandledrejection', e =>
    sendLog('error', [`Unhandled Promise: ${e.reason}`]),
  )

  const isSameFile = (fileA: string, fileB: string): boolean => {
    const norm = (f: string) =>
      f
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\//, '')
    return norm(fileA) === norm(fileB)
  }

  const checkHTMLFallback = (filename: string): boolean => {
    if (!filename.endsWith('.html')) return false
    const normFile = filename.startsWith('.')
      ? filename.substring(1)
      : filename.startsWith('/')
        ? filename
        : `/${filename}`
    const p = location.pathname

    return (
      p === normFile ||
      `${p}.html` === normFile ||
      (p.endsWith('/') ? `${p}index.html` : `${p}/index.html`) === normFile
    )
  }

  const checkSelfPage = (filename: string): boolean => {
    const currentRouteFile = (window as any).Bakery?.params()?.__file
    if (currentRouteFile) {
      return isSameFile(filename, currentRouteFile)
    }
    return checkHTMLFallback(filename)
  }

  const handleCSSUpdate = (filename: string) => {
    const normCssFile = filename.startsWith('.')
      ? filename.substring(1)
      : filename.startsWith('/')
        ? filename
        : `/${filename}`
    console.log(`[LiveReload] CSS change detected: ${filename}`)
    const links = document.querySelectorAll(
      'link[rel="stylesheet"]:not([data-removing])',
    ) as NodeListOf<HTMLLinkElement>
    for (const link of links) {
      const url = new URL(link.href, location.href)
      if (url.origin === location.origin && url.pathname === normCssFile) {
        link.setAttribute('data-removing', 'true')
        url.searchParams.set('v', String(Date.now()))
        const newHref = url.pathname + url.search
        void fetch(newHref, { mode: 'no-cors' }).then(() => {
          const newLink = document.createElement('link')
          newLink.rel = 'stylesheet'
          newLink.href = newHref
          document.head.appendChild(newLink)
          setTimeout(() => link.remove(), 50)
        })
      }
    }
  }

  const handleHtmlOrTsxUpdate = (filename: string) => {
    if (document.visibilityState !== 'visible') {
      needsReload = true
      return
    }

    const isHtmlOrTsx = filename.endsWith('.html') || filename.endsWith('.tsx')
    if (isHtmlOrTsx) {
      fetch(location.href)
        .then(res => res.text())
        .then(newHtml => {
          const diffPercent = getHtmlDifference(
            document.documentElement.outerHTML,
            newHtml,
          )
          if (diffPercent < 15) {
            const parser = new DOMParser()
            const newDoc = parser.parseFromString(newHtml, 'text/html')
            patchDOM(document.body, newDoc.body)
            console.log(
              `[LiveReload] Hot-swapped DOM body (${diffPercent.toFixed(1)}% change)`,
            )
          } else {
            console.log(
              `[LiveReload] Large change detected (${diffPercent.toFixed(1)}%), reloading...`,
            )
            location.reload()
          }
        })
        .catch(() => {
          location.reload()
        })
    } else {
      location.reload()
    }
  }

  const handleUpdate = (filename: string) => {
    const isCSS = filename.endsWith('.css')
    const isSelfPage = checkSelfPage(filename)
    const isOtherHTML = filename.endsWith('.html') && !isSelfPage

    if (isOtherHTML) return

    if (isCSS) {
      handleCSSUpdate(filename)
    } else {
      handleHtmlOrTsxUpdate(filename)
    }
  }

  ws.onmessage = e => handleUpdate(e.data)

  ws.onopen = () => {
    while (logQueue.length > 0) {
      ws.send(logQueue.shift()!)
    }

    if (isDead) {
      console.log('[LiveReload] Server is back! Refreshing...')
      location.reload()
    } else {
      console.log('[LiveReload] Connected')
    }
  }

  ws.onclose = () => {
    isDead = true
    setTimeout(connect, 1000)
  }

  ws.onerror = () => ws.close()
}

connect()

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && needsReload) {
    location.reload()
  }
})

export {}
