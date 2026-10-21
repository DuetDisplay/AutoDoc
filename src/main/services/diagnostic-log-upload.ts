import { readFile } from 'fs/promises'
import { basename } from 'path'

const MAX_ATTACHMENT_BYTES = 64 * 1024
const REDACTION = '[redacted]'
// A JSON string literal, including escaped quotes, backslashes and brackets inside it.
const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`
const JSON_STRING_ARRAY = String.raw`\[\s*(?:${JSON_STRING}(?:\s*,\s*${JSON_STRING})*)?\s*\]`

function jsonKeyPattern(key: string, value: string): RegExp {
  return new RegExp(String.raw`("${key}"\s*:\s*)${value}`, 'g')
}

const SECRET_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, REDACTION],
  [
    new RegExp(String.raw`("(?:(?:access|refresh|id)_token)"\s*:\s*)${JSON_STRING}`, 'gi'),
    `$1"${REDACTION}"`
  ],
  [/\b((?:access|refresh|id)_token\s*=\s*['"]?)[A-Za-z0-9._~+/=-]+(['"]?)/gi, `$1${REDACTION}$2`],
  [/\b((?:access|refresh|id)_token\s*:\s*)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTION}`],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTION],
  [/https?:\/\/[^\s"'<>]*autodoc-auth\.duetdisplay\.workers\.dev[^\s"'<>]*/gi, REDACTION]
]

const PATH_PATTERNS = [
  /\/Users\/[^/\s"]+/g,
  // Log entries are sanitized after JSON serialization, where Windows separators are doubled.
  // The user name may hold Go-style \xNN / \uNNNN byte escapes for non-ASCII characters; the
  // escape backslashes can be doubled too, so swallow them instead of stopping at them.
  /[A-Za-z]:\\{1,2}Users\\{1,2}(?:\\{1,2}x[0-9A-Fa-f]{2}|\\{1,2}u[0-9A-Fa-f]{4}|[^\\"])+/gi
]

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
    .replace(jsonKeyPattern('relevantWindowNames', JSON_STRING_ARRAY), '$1[]')
    .replace(jsonKeyPattern('matchedTrackedSourceName', JSON_STRING), '$1null')
    .replace(jsonKeyPattern('trackedSourceName', JSON_STRING), '$1null')
    .replace(jsonKeyPattern('sourceName', JSON_STRING), '$1null')
    .replace(jsonKeyPattern('calendarTitle', JSON_STRING), '$1null')
    .replace(jsonKeyPattern('title', JSON_STRING), '$1null')
}
