import { type JsonResponseData, jsonResponse } from '../common/json'
import { is } from '../common/misc'
import { ETag } from './etag'

export function response(body: Bun.BodyInit | null, init?: ResponseInit) {
  return new Response(body as any, init)
}
export type ResponseJsonFactory = typeof jsonResponse & {
  success: <T>(
    message: string,
    data?: T,
    status?: number,
  ) => JsonResponseData<T>
  error: <T>(status?: number, message?: string, data?: T) => JsonResponseData<T>
}

const responseJson = jsonResponse as ResponseJsonFactory
responseJson.success = function responseJsonSuccess<T>(
  message: string,
  data?: T,
  status = 200,
) {
  return responseJson(status, message, data)
}

responseJson.error = function responseJsonError<T>(
  status: any = 404,
  message = 'Error',
  data?: T,
) {
  if (typeof status === 'string') {
    data = message as any
    message = status
    status = 400
  }
  if (
    typeof status !== 'number' ||
    Number.isNaN(status) ||
    status < 100 ||
    status > 599
  ) {
    status = 400
  }
  return responseJson(status, message, data)
}

function attachData(content: any, type: string, init?: ResponseInit): Response {
  const etag = ETag.fromText(String(content))
  const headers = new Headers(init?.headers as any)

  headers.set('Content-Type', type)
  headers.set('ETag', etag)

  return new Response(content, {
    ...init,
    headers,
  })
}

response.json = responseJson

response.html = function responseHTML(
  html: string,
  status = 200,
  init?: ResponseInit,
) {
  return attachData(html, 'text/html; charset=utf-8', {
    ...init,
    status,
  })
}

response.text = function responseText(
  text: string,
  status = 200,
  init?: ResponseInit,
) {
  return attachData(text, 'text/plain; charset=utf-8', {
    ...init,
    status,
  })
}

export function redirect(url: string, status = 302) {
  return Response.redirect(url, status)
}

response.href = redirect

// Everything a reason-phrase may not contain: CR/LF would split headers, and
// bytes outside printable ASCII can make a Response constructor throw.
const RX_UNSAFE_STATUS_TEXT = /[^\t\x20-\x7e]+/g

response.error = function responseError(
  error: string | Error,
  code = 404,
  init?: ResponseInit,
) {
  error = typeof error === 'string' ? error : error.message
  // The message rides in the body as well as statusText: HTTP/2 drops the
  // reason-phrase entirely and browsers never render it, so a null-bodied
  // error was a blank page everywhere it mattered.
  return attachData(error, 'text/plain; charset=utf-8', {
    ...init,
    status: code,
    statusText: error.replace(RX_UNSAFE_STATUS_TEXT, ' ').trim(),
  })
}

response.type = function responseType(
  body: Bun.BodyInit | null,
  contentType: string,
  init?: ResponseInit,
) {
  let etag = ''

  if (is.string(body)) {
    etag = ETag.fromText(body)
  }

  const headers = new Headers(init?.headers as any)
  headers.set('Content-Type', contentType)
  etag && headers.set('ETag', etag)

  return new Response(body as any, {
    ...init,
    headers,
  })
}
