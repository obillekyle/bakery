export let refreshShimmerCache = () => {}

/**
 * Both effects below run on import. Without this guard, importing anything that
 * transitively reaches this file outside a browser throws on the first `window`
 * access — which made every module in `client/parts/` untestable, including the
 * hand-built HTML in `database.ts` that has produced every XSS found in this
 * repo. A DOM effect with no DOM is a no-op, not an error.
 */
const HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined'

;(function initDashboardShimmer() {
  if (!HAS_DOM) return
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return

  let cachedCards: {
    el: HTMLElement
    width: number
    height: number
    pageLeft: number
    pageTop: number
  }[] = []
  const mouse = { x: -9999, y: -9999 }
  let rafId = 0

  refreshShimmerCache = function updateRects() {
    const cards = Array.from(
      document.querySelectorAll('.glass-effect'),
    ) as HTMLElement[]

    cachedCards = cards.map(el => {
      const rect = el.getBoundingClientRect()
      return {
        el,
        width: rect.width,
        height: rect.height,
        pageLeft: rect.left + window.scrollX,
        pageTop: rect.top + window.scrollY,
      }
    })
  }

  /**
   * The observer below fires for every subtree mutation on the page, and
   * `refreshShimmerCache` reads `getBoundingClientRect` once per glass card —
   * a forced synchronous layout. The log console appends one node per
   * websocket frame, each in its own task, so a busy server bought one full
   * layout pass per log line. Coalescing into a frame makes that cost
   * proportional to frames, not to mutations.
   */
  let refreshRafId = 0
  function scheduleRefresh() {
    if (refreshRafId) return
    refreshRafId = requestAnimationFrame(() => {
      refreshRafId = 0
      refreshShimmerCache()
    })
  }

  window.addEventListener('resize', scheduleRefresh, { passive: true })

  const observer = new MutationObserver(scheduleRefresh)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  refreshShimmerCache()

  function updateStyles() {
    const scrollX = window.scrollX
    const scrollY = window.scrollY

    for (let i = 0; i < cachedCards.length; i++) {
      const c = cachedCards[i]
      const left = c.pageLeft - scrollX
      const top = c.pageTop - scrollY

      const rx = mouse.x - left
      const ry = mouse.y - top

      const closestX = Math.max(left, Math.min(mouse.x, left + c.width))
      const closestY = Math.max(top, Math.min(mouse.y, top + c.height))
      const dx = mouse.x - closestX
      const dy = mouse.y - closestY
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist < 200) {
        c.el.style.setProperty('--mouse-x', `${rx}px`)
        c.el.style.setProperty('--mouse-y', `${ry}px`)
      } else {
        c.el.style.removeProperty('--mouse-x')
        c.el.style.removeProperty('--mouse-y')
      }
    }
    rafId = 0
  }

  window.addEventListener(
    'pointermove',
    e => {
      mouse.x = e.clientX
      mouse.y = e.clientY
      if (!rafId) rafId = requestAnimationFrame(updateStyles)
    },
    { passive: true },
  )

  window.addEventListener(
    'scroll',
    () => {
      if (mouse.x === -9999) return
      if (!rafId) rafId = requestAnimationFrame(updateStyles)
    },
    { passive: true },
  )

  window.addEventListener('mouseleave', () => {
    mouse.x = -9999
    mouse.y = -9999
    if (!rafId) rafId = requestAnimationFrame(updateStyles)
  })
})()

;(function initDotPattern() {
  if (!HAS_DOM) return

  const canvas = document.createElement('canvas')
  canvas.id = 'dot-pattern-canvas'
  canvas.style.cssText = [
    'position: fixed',
    'inset: 0',
    'width: 100%',
    'height: 100%',
    'z-index: -1',
    'pointer-events: none',
  ].join(';')
  document.documentElement.prepend(canvas)

  const ctx = canvas.getContext('2d')!
  const DOT_SPACING = 28
  const DOT_RADIUS = 1.1
  const GLOW_RADIUS = 130

  interface Dot {
    ox: number
    oy: number
    x: number
    y: number
  }

  let dots: Dot[] = []
  const mouse = { x: -9999, y: -9999 }
  let isAnimating = false
  let isPressed = false

  function initDots() {
    dots = []
    const cols = Math.ceil(canvas.width / DOT_SPACING) + 1
    const rows = Math.ceil(canvas.height / DOT_SPACING) + 1

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ox = c * DOT_SPACING
        const oy = r * DOT_SPACING
        dots.push({ ox, oy, x: ox, y: oy })
      }
    }
  }

  function resize() {
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
    initDots()
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      draw()
    } else {
      if (!isAnimating) {
        isAnimating = true
        requestAnimationFrame(draw)
      }
    }
  }

  interface DotTarget {
    x: number
    y: number
    alpha: number
    radius: number
  }

  function computeDotTarget(dot: Dot): DotTarget {
    const dx = mouse.x - dot.ox
    const dy = mouse.y - dot.oy
    const dist = Math.sqrt(dx * dx + dy * dy)

    let targetX = dot.ox
    let targetY = dot.oy
    let alpha = 0.07
    let radius = DOT_RADIUS

    if (dist < GLOW_RADIUS) {
      const t = 1 - dist / GLOW_RADIUS
      alpha = 0.07 + t * 0.35
      radius = DOT_RADIUS + t * 0.9

      if (dist > 0.01) {
        const force = t * (isPressed ? 32 : 18)
        if (isPressed) {
          targetX = dot.ox + (dx / dist) * force
          targetY = dot.oy + (dy / dist) * force
        } else {
          targetX = dot.ox - (dx / dist) * force
          targetY = dot.oy - (dy / dist) * force
        }
      }
    }

    return { x: targetX, y: targetY, alpha, radius }
  }

  function moveDot(dot: Dot, target: DotTarget): boolean {
    const dx = target.x - dot.x
    const dy = target.y - dot.y
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      dot.x += dx * 0.15
      dot.y += dy * 0.15
      return true
    }
    dot.x = target.x
    dot.y = target.y
    return false
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    let needsMoreFrames = false

    for (let i = 0; i < dots.length; i++) {
      const dot = dots[i]
      const target = computeDotTarget(dot)
      if (moveDot(dot, target)) needsMoreFrames = true

      ctx.beginPath()
      ctx.arc(dot.x, dot.y, target.radius, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${target.alpha})`
      ctx.fill()
    }

    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      if (mouse.x !== -9999 || needsMoreFrames) {
        requestAnimationFrame(draw)
      } else {
        isAnimating = false
      }
    }
  }

  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    window.addEventListener('pointermove', e => {
      mouse.x = e.clientX
      mouse.y = e.clientY
      if (!isAnimating) {
        isAnimating = true
        requestAnimationFrame(draw)
      }
    })

    window.addEventListener('mouseleave', () => {
      mouse.x = -9999
      mouse.y = -9999
      isPressed = false
      if (!isAnimating) {
        isAnimating = true
        requestAnimationFrame(draw)
      }
    })

    window.addEventListener('pointerdown', () => {
      isPressed = true
      if (!isAnimating) {
        isAnimating = true
        requestAnimationFrame(draw)
      }
    })

    window.addEventListener('pointerup', () => {
      isPressed = false
      if (!isAnimating) {
        isAnimating = true
        requestAnimationFrame(draw)
      }
    })
  }

  window.addEventListener('resize', resize)
  resize()
  draw()
})()
