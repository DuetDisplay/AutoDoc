import { createHash } from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream } from 'fs'
import { access, rename, rm, stat } from 'fs/promises'
import { logAutodocEvent } from './autodoc-log'
import { classifyMacLanguageSetupError } from './meeting-language-reason'

const HEADER_TIMEOUT_MS = 30_000
const INACTIVITY_TIMEOUT_MS = 90_000

export interface DownloadProgress {
  file: string
  percent: number
  bytesDownloaded: number
  bytesTotal: number
}

export interface DownloadOptions {
  onProgress?: (percent: number) => void
  onBytes?: (progress: DownloadProgress) => void
  init?: RequestInit
  timeouts?: { headerMs: number; inactivityMs: number }
}

/** The server answered, but not with this file. Says nothing about the rest of the origin. */
class SourceFileError extends Error {}

// Origins that could not be reached this session. They are tried last, never skipped, so a
// temporary outage cannot leave a download with nothing to try.
const unreachableOrigins = new Set<string>()

const originOf = (url: string): string => new URL(url).origin

function parseContentRange(value: string | null): { start: number; total: number } | null {
  const match = /^bytes\s+(\d+)-\d+\/(\d+)$/i.exec(value?.trim() ?? '')
  if (!match) return null
  const [start, total] = [Number(match[1]), Number(match[2])]
  return Number.isFinite(total) && total > 0 ? { start, total } : null
}

export function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)

    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function verifyFileSha256(
  filePath: string,
  expectedSha256: string,
  label: string
): Promise<string> {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error(`Missing or invalid SHA256 for ${label}.`)
  }

  const actualSha256 = await hashFileSha256(filePath)
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    await rm(filePath, { force: true })
    throw new Error(
      `Downloaded ${label} failed SHA256 verification: expected ${expectedSha256}, received ${actualSha256}.`
    )
  }
  return actualSha256
}

async function closeFileStream(fileStream: ReturnType<typeof createWriteStream>): Promise<void> {
  if (fileStream.writableFinished || fileStream.destroyed) {
    return
  }

  const finished = new Promise<void>((resolve, reject) => {
    fileStream.once('finish', resolve)
    fileStream.once('error', reject)
  })
  fileStream.end()
  await finished
}

export async function downloadResumableFile(
  url: string,
  destPath: string,
  label: string,
  options: DownloadOptions & { resume?: boolean } = {}
): Promise<void> {
  const { onProgress, onBytes, init, resume = false } = options
  const { headerMs, inactivityMs } = options.timeouts ?? {
    headerMs: HEADER_TIMEOUT_MS,
    inactivityMs: INACTIVITY_TIMEOUT_MS
  }
  const tempPath = `${destPath}.tmp`
  let existingBytes = 0
  if (resume) {
    try {
      const info = await stat(tempPath)
      if (info.size > 0) {
        existingBytes = info.size
      }
    } catch {
      existingBytes = 0
    }
  } else {
    await rm(tempPath, { force: true })
  }

  const stall = new AbortController()
  const signal = init?.signal ? AbortSignal.any([init.signal, stall.signal]) : stall.signal
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const armStallTimer = (timeoutMs: number): void => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(
      () => stall.abort(new Error(`Failed to download ${label}: timed out waiting for the server`)),
      timeoutMs
    )
  }

  try {
    const headers = new Headers(init?.headers)
    if (existingBytes > 0) {
      headers.set('Range', `bytes=${existingBytes}-`)
    }

    armStallTimer(headerMs)
    let response = await fetch(url, { redirect: 'follow', ...init, headers, signal })

    if (existingBytes > 0 && response.status === 416) {
      await rm(tempPath, { force: true })
      existingBytes = 0
      headers.delete('Range')
      response = await fetch(url, { redirect: 'follow', ...init, headers, signal })
    }

    // Checked before touching the partial: another source can still resume from it.
    if (!response.ok) {
      throw new SourceFileError(
        `Failed to download ${label}: ${response.status} ${response.statusText}`
      )
    }

    const contentRange = parseContentRange(response.headers.get('content-range'))
    if (existingBytes > 0 && response.status === 206) {
      if (contentRange && contentRange.start !== existingBytes) {
        void response.body?.cancel().catch(() => {})
        await rm(tempPath, { force: true })
        throw new SourceFileError(
          `Failed to download ${label}: server resumed at offset ${contentRange.start}, expected ${existingBytes}`
        )
      }
    } else if (existingBytes > 0) {
      await rm(tempPath, { force: true })
      existingBytes = 0
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0)
    const totalBytes =
      contentRange?.total ??
      (existingBytes > 0 && contentLength > 0 ? existingBytes + contentLength : contentLength)
    let downloadedBytes = 0
    let lastReportedPercent: number | undefined
    const reportProgress = (percent: number): void => {
      if (percent === lastReportedPercent) return
      lastReportedPercent = percent
      onProgress?.(percent)
    }

    const fileStream = createWriteStream(tempPath, { flags: existingBytes > 0 ? 'a' : 'w' })
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`No response body for ${label}`)

    try {
      // Unknown-size downloads stay indeterminate; callers signal completion by phase.
      if (totalBytes <= 0) reportProgress(0)
      while (true) {
        if (signal.aborted) {
          // Keep the partial file: a verified download resumes on the next try.
          void reader.cancel().catch(() => {})
          throw signal.reason
        }
        armStallTimer(inactivityMs)
        const { done, value } = await reader.read()
        clearTimeout(stallTimer)
        if (done) break
        if (!fileStream.write(value)) {
          await once(fileStream, 'drain')
        }
        downloadedBytes += value.length
        const completedBytes = existingBytes + downloadedBytes
        const percent = totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 100) : 0
        reportProgress(percent)
        onBytes?.({
          file: label,
          percent,
          bytesDownloaded: completedBytes,
          bytesTotal: totalBytes
        })
      }

      if (totalBytes > 0) reportProgress(100)
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })

      if (contentLength > 0 && downloadedBytes !== contentLength) {
        throw new Error(
          `Downloaded ${label} was incomplete: expected ${contentLength} bytes, received ${downloadedBytes}.`
        )
      }

      await rm(destPath, { force: true })
      await rename(tempPath, destPath)
    } catch (err) {
      await closeFileStream(fileStream)
      if (!resume) {
        await rm(tempPath, { force: true })
      }
      throw err
    }
  } catch (err) {
    throw stall.signal.aborted && !init?.signal?.aborted ? stall.signal.reason : err
  } finally {
    clearTimeout(stallTimer)
  }
}

async function fetchAndVerify(
  source: string,
  destPath: string,
  sha256: string,
  label: string,
  options: DownloadOptions
): Promise<string> {
  await downloadResumableFile(source, destPath, label, { ...options, resume: true })
  try {
    return await verifyFileSha256(destPath, sha256, label)
  } catch {
    // A bad partial can come from an earlier source, so start clean once before giving up on it.
    await rm(`${destPath}.tmp`, { force: true })
    await downloadResumableFile(source, destPath, label, { ...options, resume: true })
    return await verifyFileSha256(destPath, sha256, label)
  }
}

/**
 * Downloads one SHA-pinned file, trying each source once. Every source must serve the same bytes,
 * so a partial can resume on another source and the final hash decides what is trusted.
 */
export async function downloadVerifiedFile(
  sources: readonly string[],
  destPath: string,
  sha256: string,
  label: string,
  options: DownloadOptions = {}
): Promise<string> {
  const alreadyPresent = await access(destPath).then(
    () => true,
    () => false
  )
  if (alreadyPresent) {
    try {
      return await verifyFileSha256(destPath, sha256, label)
    } catch {
      // Mismatch deletes destPath; fetch a replacement below.
    }
  }

  const ordered = [...sources].sort(
    (a, b) =>
      Number(unreachableOrigins.has(originOf(a))) - Number(unreachableOrigins.has(originOf(b)))
  )
  let lastError: unknown
  for (const source of ordered) {
    try {
      return await fetchAndVerify(source, destPath, sha256, label, options)
    } catch (error) {
      if (options.init?.signal?.aborted) throw error
      const reason = classifyMacLanguageSetupError(error)
      if (reason !== 'setup-download-failed' && reason !== 'setup-verification-failed') throw error
      lastError = error
      if (reason === 'setup-download-failed' && !(error instanceof SourceFileError)) {
        unreachableOrigins.add(originOf(source))
      }
      logAutodocEvent({
        area: 'whisper',
        level: 'warn',
        message: 'download source failed',
        context: { label, origin: originOf(source), reason }
      })
    }
  }
  throw lastError
}
