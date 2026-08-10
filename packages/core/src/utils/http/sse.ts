/**
 * Server-sent events.
 *
 * Bakery had WebSockets and nothing for one-way streaming, which is the cheaper
 * half of that pair and the right shape for progress, notifications and tailing
 * — no upgrade, no protocol, reconnects handled by the browser.
 *
 * A route could always return a `Response` wrapping a `ReadableStream` and it
 * would reach the client intact: `ETag.sendResponse` returns early without an
 * `ETag` header, and `injectIfHtml` ignores anything that is not HTML. What was
 * missing is the framing, and framing is where this goes wrong — a payload
 * containing a newline silently truncates unless every line is prefixed, and a
 * write after the client has gone throws where nobody is catching.
 */

/** One event. Every field is optional except the payload. */
export interface SSEMessage {
  /** Serialised with `JSON.stringify` unless it is already a string. */
  data: unknown
  /** `event:` — the client listens for this name instead of `message`. */
  event?: string
  /** `id:` — echoed back as `Last-Event-ID` when the browser reconnects. */
  id?: string
  /** `retry:` — how long the browser waits before reconnecting, in ms. */
  retry?: number
}

/** The handle a producer writes to. */
export interface SSEStream {
  /** Send one event. A no-op once the stream is closed. */
  send(message: SSEMessage | unknown): void
  /** Send a `:` comment. Useful as a keep-alive through idle proxies. */
  comment(text?: string): void
  /** Close the stream. Idempotent. */
  close(): void
  /** True once the client has gone or `close()` has run. */
  readonly closed: boolean
}

export interface SSEOptions {
  /**
   * Milliseconds between automatic keep-alive comments. `0` disables them.
   *
   * Defaults to 15s because idle proxies and load balancers commonly cut a
   * connection at 30–60s, and a dead SSE stream is invisible: the browser
   * reconnects silently, so the symptom is duplicated work on the server rather
   * than an error anyone sees.
   */
  keepAlive?: number
  /** Initial `retry:` hint sent once, before any event. */
  retry?: number
}

/**
 * Encode one message as an SSE frame.
 *
 * **Every line of `data` is prefixed.** A payload containing a newline is
 * otherwise cut short at that newline — the rest is read as a new field, and
 * the client sees a truncated message rather than an error. Pretty-printed JSON
 * and stack traces both hit this.
 */
export function encodeSSE(message: SSEMessage): string {
  const lines: string[] = []

  if (message.event) lines.push(`event: ${message.event}`)
  if (message.id !== undefined) lines.push(`id: ${message.id}`)
  if (message.retry !== undefined) lines.push(`retry: ${message.retry}`)

  const payload =
    typeof message.data === 'string'
      ? message.data
      : JSON.stringify(message.data)

  // `?? ''` rather than skipping: `JSON.stringify(undefined)` is undefined, and
  // a frame with no `data:` line at all is a comment to the client — the event
  // would vanish rather than arrive empty.
  for (const line of (payload ?? '').split('\n')) lines.push(`data: ${line}`)

  // The blank line terminates the frame. Without it the client buffers forever.
  return `${lines.join('\n')}\n\n`
}

/**
 * Build an SSE response and hand the producer a stream to write to.
 *
 *     export default defineRoute(req =>
 *       sse(req, stream => {
 *         const timer = setInterval(() => stream.send({ now: Date.now() }), 1000)
 *         return () => clearInterval(timer)
 *       }),
 *     )
 *
 * The producer may return a cleanup function, which runs exactly once when the
 * client disconnects or `close()` is called. That is the only reliable place to
 * stop a timer or unsubscribe: without it, a closed connection leaves the
 * interval running for the life of the process, and the leak is silent.
 */
export function sse(
  req: Request,
  producer: (
    stream: SSEStream,
  ) => void | (() => void) | Promise<void | (() => void)>,
  options: SSEOptions = {},
): Response {
  const encoder = new TextEncoder()
  const { keepAlive = 15_000, retry } = options

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let cleanup: (() => void) | void
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined

  const write = (chunk: string) => {
    if (closed || !controller) return
    try {
      controller.enqueue(encoder.encode(chunk))
    } catch {
      // The client went away between the `closed` check and the enqueue. That
      // is a normal race on every disconnect, not an error worth surfacing —
      // and throwing here would reject inside a timer callback, where nothing
      // is catching.
      finish()
    }
  }

  function finish() {
    if (closed) return
    closed = true
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    try {
      cleanup?.()
    } catch {
      // A producer's cleanup that throws must not prevent the stream closing;
      // the connection is already going away either way.
    }
    try {
      controller?.close()
    } catch {
      // Already closed by the runtime when the client disconnected.
    }
  }

  const stream: SSEStream = {
    send(message) {
      const normalised: SSEMessage =
        message && typeof message === 'object' && 'data' in (message as object)
          ? (message as SSEMessage)
          : { data: message }
      write(encodeSSE(normalised))
    },
    comment(text = '') {
      write(`: ${text}\n\n`)
    },
    close: finish,
    get closed() {
      return closed
    },
  }

  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c

      // The client aborting is the common ending, not an exception. Without
      // this the producer keeps writing into a dead socket.
      req.signal?.addEventListener('abort', finish, { once: true })
      if (req.signal?.aborted) return finish()

      if (retry !== undefined) write(`retry: ${retry}\n\n`)
      if (keepAlive > 0) {
        keepAliveTimer = setInterval(
          () => stream.comment('keep-alive'),
          keepAlive,
        )
      }

      try {
        cleanup = await producer(stream)
      } catch {
        // A producer that throws ends the stream rather than leaving the client
        // hanging on a connection nobody will write to again.
        finish()
      }
    },
    cancel: finish,
  })

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // A cached event stream is a stream that never arrives.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx buffers proxied responses by default, which holds every event
      // until the buffer fills — the stream appears to work in development and
      // to hang in production. This is the documented opt-out.
      'X-Accel-Buffering': 'no',
    },
  })
}
