import type { MapOf } from '../../types'

export async function processBody(req: Request): Promise<MapOf<any>> {
  const getParsedBody = async (): Promise<MapOf<any>> => {
    switch (req.method) {
      case 'GET':
      case 'HEAD': {
        return getBodyFromURI(req)
      }
      default: {
        return await getBodyFromReq(req)
      }
    }
  }

  const parsedBody = await getParsedBody().catch(() => ({}))
  return parsedBody
}

function getBodyFromURI(req: Request): MapOf<any> {
  const url = (req as any).__parsedUrl || new URL(req.url)
  const searchParams = url.searchParams
  return Object.fromEntries(searchParams.entries())
}

function isFormData(contentType: string): boolean {
  return (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  )
}

function isFileLike(contentType: string): boolean {
  return (
    contentType.includes('application/') ||
    contentType.includes('audio/') ||
    contentType.includes('video/') ||
    contentType.includes('model/') ||
    contentType.includes('image/')
  )
}

async function getBodyFromReq(req: Request) {
  const contentType = req.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return (await req.json()) as Promise<MapOf<any>>
  }

  if (isFormData(contentType)) {
    const formData = await req.formData()
    const data: MapOf<any> = {}

    for (const [key, value] of formData.entries()) {
      data[key] = key in data ? [data[key], value].flat() : value
    }
    return data
  }

  if (isFileLike(contentType)) {
    return { file: await req.blob() }
  }

  return { data: await req.text() }
}
