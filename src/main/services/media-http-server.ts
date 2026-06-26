import http from 'http'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { basename, join, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { isEncrypted, getDecryptedTempPathForMedia, clearMediaDecryptCache } from './crypto'
import { logAutodocFailure } from './autodoc-log'

const ALLOWED_FILENAMES = new Set(['screen.webm', 'system.webm', 'audio.webm', 'mic.webm'])

/** Relaxed UUID (any version) — meeting IDs are UUIDs. */
const MEETING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function contentType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  return 'application/octet-stream'
}

function isTrustedServePath(absPath: string, recordingsBaseDir: string): boolean {
  const abs = resolve(absPath)
  const base = resolve(recordingsBaseDir)
  const baseWithSep = base.endsWith(sep) ? base : base + sep
  if (abs === base || abs.startsWith(baseWithSep)) return true
  const tmpRoot = resolve(tmpdir())
  const tmpWithSep = tmpRoot.endsWith(sep) ? tmpRoot : tmpRoot + sep
  if (!abs.startsWith(tmpWithSep)) return false
  return /^autodoc-[0-9a-f]{16}\./.test(basename(abs))
}

function parseByteRange(
  rangeHeader: string | undefined,
  fileSize: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (fileSize <= 0) {
    return rangeHeader?.toLowerCase().startsWith('bytes=') ? 'unsatisfiable' : null
  }
  if (!rangeHeader || !rangeHeader.toLowerCase().startsWith('bytes=')) return null
  const spec = rangeHeader.slice(6).trim()
  if (!spec || spec.includes(',')) return 'unsatisfiable'

  if (spec.startsWith('-')) {
    const suffix = parseInt(spec.slice(1), 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    if (suffix >= fileSize) return { start: 0, end: fileSize - 1 }
    return { start: fileSize - suffix, end: fileSize - 1 }
  }

  const dash = spec.indexOf('-')
  if (dash < 0) return 'unsatisfiable'
  const startStr = spec.slice(0, dash)
  const endStr = spec.slice(dash + 1)
  if (startStr === '') return 'unsatisfiable'

  const start = parseInt(startStr, 10)
  if (!Number.isFinite(start) || start < 0 || start >= fileSize) return 'unsatisfiable'

  const end = endStr === '' ? fileSize - 1 : parseInt(endStr, 10)
  if (!Number.isFinite(end)) return 'unsatisfiable'
  const endClamped = Math.min(end, fileSize - 1)
  if (start > endClamped) return 'unsatisfiable'
  return { start, end: endClamped }
}

/** Client closed connection or seek aborted the pipe — not worth a Sentry event. */
function isBenignMediaStreamError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
}

function parseMeetingIdFromRequestUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const pathname = new URL(url, 'http://127.0.0.1').pathname
    const m = /^\/media\/([^/]+)\//.exec(pathname)
    return m?.[1]
  } catch {
    return undefined
  }
}

function reportMediaServerFailure(
  message: string,
  error: unknown,
  context: Record<string, unknown>,
  meetingId?: string
): void {
  logAutodocFailure({
    area: 'recording',
    message,
    error,
    meetingId,
    context: { component: 'media-http-server', ...context }
  })
}

async function resolveServePath(diskPath: string): Promise<string | null> {
  try {
    await stat(diskPath)
  } catch {
    return null
  }
  return (await isEncrypted(diskPath)) ? getDecryptedTempPathForMedia(diskPath) : diskPath
}

async function handleMediaRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getRecordingsBaseDir: () => string
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.end()
    return
  }

  const baseUrl = 'http://127.0.0.1'
  let pathname: string
  try {
    pathname = new URL(req.url ?? '/', baseUrl).pathname
  } catch {
    res.statusCode = 400
    res.end()
    return
  }

  const match = /^\/media\/([^/]+)\/([^/]+)$/.exec(pathname)
  if (!match) {
    res.statusCode = 404
    res.end()
    return
  }

  const meetingId = match[1]
  const filename = match[2]
  if (!MEETING_ID_RE.test(meetingId) || !ALLOWED_FILENAMES.has(filename)) {
    res.statusCode = 404
    res.end()
    return
  }

  const recordingsBase = getRecordingsBaseDir()
  const diskPath = join(recordingsBase, meetingId, filename)
  const servePath = await resolveServePath(diskPath)
  if (!servePath || !isTrustedServePath(servePath, recordingsBase)) {
    res.statusCode = 404
    res.end()
    return
  }

  let fileSize: number
  try {
    fileSize = (await stat(servePath)).size
  } catch {
    res.statusCode = 404
    res.end()
    return
  }

  const rangeHeader = req.headers.range
  const parsed = parseByteRange(rangeHeader, fileSize)
  const ct = contentType(filename)

  if (parsed === 'unsatisfiable') {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${fileSize}`)
    res.end()
    return
  }

  const baseHeaders: Record<string, string> = {
    'Content-Type': ct,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }

  const isFull = parsed === null || (parsed.start === 0 && parsed.end === fileSize - 1)

  if (isFull) {
    res.statusCode = 200
    res.setHeader('Content-Length', String(fileSize))
    for (const [k, v] of Object.entries(baseHeaders)) res.setHeader(k, v)
    if (method === 'HEAD') {
      res.end()
      return
    }
    const rs = createReadStream(servePath)
    rs.on('error', (err) => {
      if (!isBenignMediaStreamError(err)) {
        reportMediaServerFailure(
          'Recording media read stream error (full)',
          err,
          {
            filename,
            servePathPresent: true
          },
          meetingId
        )
      }
      if (!res.headersSent) res.statusCode = 500
      res.destroy()
    })
    rs.pipe(res)
    return
  }

  const { start, end } = parsed
  const chunkLength = end - start + 1
  res.statusCode = 206
  res.setHeader('Content-Length', String(chunkLength))
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
  for (const [k, v] of Object.entries(baseHeaders)) res.setHeader(k, v)
  if (method === 'HEAD') {
    res.end()
    return
  }
  const rs = createReadStream(servePath, { start, end })
  rs.on('error', (err) => {
    if (!isBenignMediaStreamError(err)) {
      reportMediaServerFailure(
        'Recording media read stream error (range)',
        err,
        {
          filename,
          range: { start, end }
        },
        meetingId
      )
    }
    if (!res.headersSent) res.statusCode = 500
    res.destroy()
  })
  rs.pipe(res)
}

let mediaServer: http.Server | null = null

/**
 * Serves decrypted/plain recording files on 127.0.0.1 with Range support so `<video>` can seek.
 * Custom `protocol` handlers in Electron are unreliable for both decode and seeking; loopback HTTP is not.
 */
export async function startRecordingMediaHttpServer(
  getRecordingsBaseDir: () => string
): Promise<number> {
  if (mediaServer) {
    const addr = mediaServer.address()
    if (typeof addr === 'object' && addr?.port) return addr.port
  }

  return await new Promise((resolvePort, reject) => {
    const server = http.createServer((req, res) => {
      const meetingId = parseMeetingIdFromRequestUrl(req.url)
      void handleMediaRequest(req, res, getRecordingsBaseDir).catch((err) => {
        reportMediaServerFailure(
          'Recording media HTTP handler threw',
          err,
          {
            method: req.method,
            url: req.url ?? null
          },
          meetingId
        )
        if (!res.headersSent) res.statusCode = 500
        res.end()
      })
    })

    server.on('error', (err) => {
      if (mediaServer === server) {
        reportMediaServerFailure('Recording media HTTP server runtime error', err, {
          phase: 'runtime'
        })
        return
      }
      reportMediaServerFailure('Recording media HTTP server failed to listen', err, {
        phase: 'listen'
      })
      reject(err)
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr?.port) {
        mediaServer = server
        resolvePort(addr.port)
      } else {
        const err = new Error('Recording media server: could not bind')
        reportMediaServerFailure('Recording media HTTP server bind address missing', err, {
          phase: 'listen-callback'
        })
        reject(err)
      }
    })
  })
}

export function stopRecordingMediaHttpServer(): void {
  const server = mediaServer
  mediaServer = null
  if (!server) {
    void clearMediaDecryptCache()
    return
  }

  server.close(() => {
    void clearMediaDecryptCache()
  })
}
