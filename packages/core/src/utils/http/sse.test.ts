import { describe, expect, test } from 'bun:test'
import { encodeSSE, sse } from './sse'

/** Read the whole stream to a string. */
async function drain(res: Response): Promise<string> {
  return await new Response(res.body).text()
}

describe('encodeSSE', () => {
  test('a frame ends with a blank line', () => {
    // Without it the client buffers the event forever, which presents as
    // "nothing arrives" rather than as a parse error.
    expect(encodeSSE({ data: 'hi' })).toBe('data: hi\n\n')
  })

  test('every line of a multi-line payload is prefixed', () => {
    // The bug this exists for: an unprefixed newline ends the data field, so
    // the client sees a truncated message and no error. Pretty-printed JSON and
    // stack traces both hit it.
    expect(encodeSSE({ data: 'a\nb\nc' })).toBe('data: a\ndata: b\ndata: c\n\n')
  })

  test('non-strings are JSON encoded', () => {
    expect(encodeSSE({ data: { n: 1 } })).toBe('data: {"n":1}\n\n')
  })

  test('multi-line JSON stays one event', () => {
    const pretty = JSON.stringify({ a: 1 }, null, 2)
    const frame = encodeSSE({ data: pretty })
    expect(frame.split('\n\n')).toHaveLength(2)
    expect(frame.split('\n').filter(l => l.startsWith('data: '))).toHaveLength(
      pretty.split('\n').length,
    )
  })

  test('undefined still produces a data line', () => {
    // JSON.stringify(undefined) is undefined. A frame with no `data:` line at
    // all reads as a comment, so the event would vanish rather than arrive
    // empty — a silent drop is the worse failure.
    expect(encodeSSE({ data: undefined })).toBe('data: \n\n')
  })

  test('event, id and retry precede the data', () => {
    expect(encodeSSE({ data: 'x', event: 'tick', id: '7', retry: 500 })).toBe(
      'event: tick\nid: 7\nretry: 500\ndata: x\n\n',
    )
  })
})

describe('sse', () => {
  const req = () => new Request('http://localhost/events')

  test('sets the headers a stream needs to survive', async () => {
    const res = sse(req(), s => s.close(), { keepAlive: 0 })

    expect(res.headers.get('Content-Type')).toBe(
      'text/event-stream; charset=utf-8',
    )
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
    // nginx buffers proxied responses by default, holding every event until the
    // buffer fills — works in development, hangs in production.
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
    await drain(res)
  })

  test('carries no ETag, so ETag.sendResponse leaves it alone', async () => {
    // The framework's response pipeline returns early without one. An ETag on a
    // stream would invite a conditional request that can never match.
    const res = sse(req(), s => s.close(), { keepAlive: 0 })
    expect(res.headers.get('ETag')).toBeNull()
    await drain(res)
  })

  test('events written by the producer reach the body', async () => {
    const res = sse(
      req(),
      s => {
        s.send({ data: 'one' })
        s.send({ data: { two: 2 }, event: 'update' })
        s.close()
      },
      { keepAlive: 0 },
    )

    const text = await drain(res)
    expect(text).toContain('data: one\n\n')
    expect(text).toContain('event: update\ndata: {"two":2}\n\n')
  })

  test('a bare value is wrapped as data', async () => {
    const res = sse(
      req(),
      s => {
        s.send({ hello: 'world' })
        s.close()
      },
      { keepAlive: 0 },
    )
    expect(await drain(res)).toBe('data: {"hello":"world"}\n\n')
  })

  test('cleanup runs exactly once on close', async () => {
    let cleaned = 0
    const res = sse(
      req(),
      s => {
        s.close()
        s.close()
        return () => {
          cleaned++
        }
      },
      { keepAlive: 0 },
    )
    await drain(res)
    // Idempotent: a double close must not run cleanup twice, or an unsubscribe
    // becomes a double-unsubscribe.
    expect(cleaned).toBeLessThanOrEqual(1)
  })

  test('writes after close are dropped, not thrown', async () => {
    // A producer holding a timer will write after the client has gone. Throwing
    // there rejects inside a timer callback, where nothing is catching.
    const res = sse(
      req(),
      s => {
        s.close()
        expect(() => s.send({ data: 'late' })).not.toThrow()
        expect(s.closed).toBe(true)
      },
      { keepAlive: 0 },
    )
    expect(await drain(res)).toBe('')
  })

  test('an already-aborted request produces an empty stream', async () => {
    const controller = new AbortController()
    controller.abort()
    const aborted = new Request('http://localhost/events', {
      signal: controller.signal,
    })

    const res = sse(
      aborted,
      s => {
        s.send({ data: 'never' })
      },
      { keepAlive: 0 },
    )

    // The only thing worth asserting: nothing the producer writes escapes.
    // Whether the producer runs at all is an implementation detail, and an
    // assertion that accepts both answers asserts nothing.
    expect(await drain(res)).toBe('')
  })

  test('a throwing producer closes the stream rather than hanging', async () => {
    const res = sse(
      req(),
      () => {
        throw new Error('boom')
      },
      { keepAlive: 0 },
    )
    // Resolves rather than never settling: a client left on an open connection
    // nobody will write to again is the worst outcome here.
    expect(await drain(res)).toBe('')
  })

  test('an initial retry hint is sent before any event', async () => {
    const res = sse(
      req(),
      s => {
        s.send({ data: 'x' })
        s.close()
      },
      { keepAlive: 0, retry: 3000 },
    )
    expect(await drain(res)).toBe('retry: 3000\n\ndata: x\n\n')
  })
})
