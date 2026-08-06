;(function initDotPattern() {
  const canvas = document.createElement('canvas')
  canvas.id = 'dot-pattern-canvas'
  canvas.style.cssText = [
    'position: fixed',
    'inset: 0',
    'width: 100%',
    'height: 100%',
    'z-index: 0',
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
  let isTabVisible = !document.hidden

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

  function getHoverTarget(dot: Dot, dist: number, dx: number, dy: number) {
    if (dist >= GLOW_RADIUS || dist <= 0.01) {
      return {
        targetX: dot.ox,
        targetY: dot.oy,
        alpha: 0.07,
        radius: DOT_RADIUS,
      }
    }

    const t = 1 - dist / GLOW_RADIUS
    const alpha = 0.07 + t * 0.35
    const radius = DOT_RADIUS + t * 0.9
    const force = t * (isPressed ? 32 : 18)
    const dirX = dx / dist
    const dirY = dy / dist

    const targetX = isPressed ? dot.ox + dirX * force : dot.ox - dirX * force
    const targetY = isPressed ? dot.oy + dirY * force : dot.oy - dirY * force

    return { targetX, targetY, alpha, radius }
  }

  function updateAndDrawDot(dot: Dot): boolean {
    const dx = mouse.x - dot.ox
    const dy = mouse.y - dot.oy
    const dist = Math.sqrt(dx * dx + dy * dy)

    const { targetX, targetY, alpha, radius } = getHoverTarget(
      dot,
      dist,
      dx,
      dy,
    )

    const dx_move = targetX - dot.x
    const dy_move = targetY - dot.y

    let dotMoved = false
    if (Math.abs(dx_move) > 0.01 || Math.abs(dy_move) > 0.01) {
      dot.x += dx_move * 0.15
      dot.y += dy_move * 0.15
      dotMoved = true
    } else {
      dot.x = targetX
      dot.y = targetY
    }

    ctx.beginPath()
    ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`
    ctx.fill()

    return dotMoved
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    let needsMoreFrames = false

    for (let i = 0; i < dots.length; i++) {
      if (updateAndDrawDot(dots[i])) {
        needsMoreFrames = true
      }
    }

    if (
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      isTabVisible
    ) {
      if (needsMoreFrames) {
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

  document.addEventListener('visibilitychange', () => {
    isTabVisible = !document.hidden
    if (isTabVisible && !isAnimating) {
      isAnimating = true
      requestAnimationFrame(draw)
    }
  })

  window.addEventListener('resize', resize)
  resize()
  draw()
})()
;(function initCardShimmer() {
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>('.glass-effect'),
  )
  if (!cards.length) return

  cards.forEach((card, index) => {
    card.style.animationDelay = `${(index + 1) * 0.1}s`
    card.style.animationName = 'fadeInUp'
    card.style.animationDuration = '0.8s'
    card.style.animationTimingFunction = 'ease-out'
    card.style.animationFillMode = 'backwards'
  })

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

  function updateRects() {
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

  window.addEventListener('resize', updateRects, { passive: true })

  const observer = new MutationObserver(() => {
    updateRects()
  })
  observer.observe(document.body, { childList: true, subtree: true })

  updateRects()

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

const counterValue = document.getElementById('counter-value')
const incrementBtn = document.getElementById('increment-btn')

if (counterValue && incrementBtn) {
  incrementBtn.addEventListener('click', () => {
    const current = Number(counterValue.textContent ?? '0')
    counterValue.textContent = String(current + 1)
  })
}

const apiBtn = document.getElementById('api-btn')
const apiResponse = document.getElementById('api-response')

if (apiBtn && apiResponse) {
  apiBtn.addEventListener('click', async () => {
    apiResponse.textContent = await request('/api/hello')
      .then(data => JSON.stringify(data, null, 2))
      .catch(e => String(e))
  })
}

const perfBtn = document.getElementById('perf-test-btn')
const perfResult = document.getElementById('perf-result')

if (perfBtn && perfResult) {
  perfBtn.addEventListener('click', async function requestPerformance() {
    perfResult.textContent = 'Benchmarking server speed...\n Please wait...'

    const testId = `perf-test-${Date.now()}`
    const testPath = `/blog/${testId}.html`

    const start1 = performance.now()
    const res1 = await fetch(testPath)
    await res1.text()
    const end1 = performance.now()
    const time1 = end1 - start1

    const start2 = performance.now()
    const res2 = await fetch(testPath)
    await res2.text()
    const end2 = performance.now()
    const time2 = end2 - start2

    perfResult.innerHTML = `
      Dynamic: <span style="color: #ff5f56; font-weight: bold;">${time1.toFixed(1)}ms</span><br>
      Cached: <span style="color: #27c93f; font-weight: bold;">${time2.toFixed(1)}ms</span> (${(time1 / Math.max(time2, 0.01)).toFixed(1)}x faster)
    `
  })
}
