import { readFile } from 'fs/promises'
import { basename } from 'path'

const MAX_ATTACHMENT_BYTES = 64 * 1024
const REDACTION = '[redacted]'

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(access|refresh|id)_token["'=:\s]+[A-Za-z0-9._~+/=-]+/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /https?:\/\/[^\s"'<>]*autodoc-auth\.duetdisplay\.workers\.dev[^\s"'<>]*/gi
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

  const raw = await readFile(logPath, 'utf-8').catch(() => null)
  if (!raw) {
    return null
  }

  const tail = raw.length > MAX_ATTACHMENT_BYTES ? raw.slice(-MAX_ATTACHMENT_BYTES) : raw
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

  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTION)
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
