// INTERNAL-ONLY: authenticated upload endpoint for the AutoDoc Internal
// update feed bucket. Reads are served by the R2 custom domain; this worker
// exists because CI has no R2 API token (only account admins can mint those).
//
// Endpoints (all require "Authorization: Bearer <UPLOAD_TOKEN>"):
//   PUT  /<key>                          — simple upload (small files)
//   POST /mpu/create?key=<key>           — start multipart upload, returns uploadId
//   PUT  /mpu/part?key=<key>&uploadId=..&partNumber=N — upload one part, returns etag
//   POST /mpu/complete?key=<key>&uploadId=..          — body: JSON [{partNumber, etag}, ...]
//
// Keys are restricted to windows/<file> or mac/<file>.

interface Env {
  FEED_BUCKET: R2Bucket
  UPLOAD_TOKEN: string
}

const KEY_PATTERN = /^(windows|mac)\/[A-Za-z0-9][A-Za-z0-9._ -]*$/

function unauthorized(): Response {
  return new Response('Unauthorized\n', { status: 401 })
}

function badRequest(message: string): Response {
  return new Response(`${message}\n`, { status: 400 })
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.UPLOAD_TOKEN) {
    return false
  }
  const header = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${env.UPLOAD_TOKEN}`
  if (header.length !== expected.length) {
    return false
  }
  // Constant-time comparison to avoid trivially timing the token.
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
}

function getValidKey(url: URL): string | null {
  const key = url.searchParams.get('key') ?? decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  return KEY_PATTERN.test(key) ? key : null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return unauthorized()
    }

    const url = new URL(request.url)

    if (url.pathname === '/mpu/create' && request.method === 'POST') {
      const key = getValidKey(url)
      if (!key) return badRequest('Invalid or missing key')
      const upload = await env.FEED_BUCKET.createMultipartUpload(key, {
        httpMetadata: {
          contentType: url.searchParams.get('contentType') ?? 'application/octet-stream'
        }
      })
      return Response.json({ key: upload.key, uploadId: upload.uploadId })
    }

    if (url.pathname === '/mpu/part' && request.method === 'PUT') {
      const key = getValidKey(url)
      const uploadId = url.searchParams.get('uploadId')
      const partNumber = Number(url.searchParams.get('partNumber'))
      if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
        return badRequest('Invalid key/uploadId/partNumber')
      }
      if (!request.body) return badRequest('Missing body')
      const upload = env.FEED_BUCKET.resumeMultipartUpload(key, uploadId)
      const part = await upload.uploadPart(partNumber, request.body)
      return Response.json({ partNumber: part.partNumber, etag: part.etag })
    }

    if (url.pathname === '/mpu/complete' && request.method === 'POST') {
      const key = getValidKey(url)
      const uploadId = url.searchParams.get('uploadId')
      if (!key || !uploadId) return badRequest('Invalid key/uploadId')
      const parts = (await request.json()) as { partNumber: number; etag: string }[]
      const upload = env.FEED_BUCKET.resumeMultipartUpload(key, uploadId)
      const object = await upload.complete(parts)
      return Response.json({ key: object.key, etag: object.httpEtag, size: object.size })
    }

    if (request.method === 'PUT') {
      const key = getValidKey(url)
      if (!key) return badRequest('Invalid key')
      if (!request.body) return badRequest('Missing body')
      const object = await env.FEED_BUCKET.put(key, request.body, {
        httpMetadata: {
          contentType: request.headers.get('content-type') ?? 'application/octet-stream'
        }
      })
      return Response.json({ key: object.key, etag: object.httpEtag, size: object.size })
    }

    return new Response('Method not allowed\n', { status: 405 })
  }
}
