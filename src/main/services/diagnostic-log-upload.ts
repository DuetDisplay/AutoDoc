import { readFile } from 'fs/promises'
import { basename } from 'path'

const MAX_ATTACHMENT_BYTES = 64 * 1024
const REDACTION = '[redacted]'

const SECRET_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, REDACTION],
  [/("(?:(?:access|refresh|id)_token)"\s*:\s*)"[^"]*"/gi, `$1"${REDACTION}"`],
  [/\b((?:access|refresh|id)_token\s*=\s*['"]?)[A-Za-z0-9._~+/=-]+(['"]?)/gi, `$1${REDACTION}$2`],
  [/\b((?:access|refresh|id)_token\s*:\s*)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTION}`],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTION],
  [/https?:\/\/[^\s"'<>]*autodoc-auth\.duetdisplay\.workers\.dev[^\s"'<>]*/gi, REDACTION]
]

const PATH_PATTERNS = [/\/Users\/[^/\s]+/g, /[A-Za-z]:\\Users\\[^\\\s]+/g]

export interface DiagnosticLogAttachment {
  filename: string
  contentType: 'text/plain'
  data: string
}

export async function buildDiagnosticLogAttachment(
  enabled: boolean,
  logPath: string
): Promise<DiagnosticLogAttachment | null> {
  if (!enabled) {
    return null
  }

  const raw = await readFile(logPath).catch(() => null)
  if (!raw) {
    return null
  }

  const tailBuffer =
    raw.byteLength > MAX_ATTACHMENT_BYTES
      ? raw.subarray(raw.byteLength - MAX_ATTACHMENT_BYTES)
      : raw
  const tail = tailBuffer.toString('utf-8')
  const sanitized = sanitizeDiagnosticLogTail(tail).trim()
  if (!sanitized) {
    return null
  }

  return {
    filename: `${basename(logPath, '.log')}-diagnostic-tail.log`,
    contentType: 'text/plain',
    data: sanitized
  }
}

export function sanitizeDiagnosticLogTail(value: string): string {
  let sanitized = value

  for (const [pattern, replacement] of SECRET_REPLACEMENTS) {
    sanitized = sanitized.replace(pattern, replacement)
  }

  for (const pattern of PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[home]')
  }

  return sanitized
    .replace(/("relevantWindowNames"\s*:\s*)\[[^\]]*\]/g, '$1[]')
    .replace(/("matchedTrackedSourceName"\s*:\s*)"[^"]*"/g, '$1null')
    .replace(/("trackedSourceName"\s*:\s*)"[^"]*"/g, '$1null')
    .replace(/("sourceName"\s*:\s*)"[^"]*"/g, '$1null')
    .replace(/("calendarTitle"\s*:\s*)"[^"]*"/g, '$1null')
    .replace(/("title"\s*:\s*)"[^"]*"/g, '$1null')
}
