const TIMESTAMP = /\s*\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:–\d{1,2}:\d{2}(?::\d{2})?)?\]\s*/gu
const SPEAKER_TAG = /\[(?:them|me)\]/giu
const OWNER_NULL = /\(?\s*Owner:\s*null\s*\)?/giu
const CITATION = /\(src:[^)]*\)|\[cite:[^\]]*\]|\[[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\]/giu

export function stripLegacyDecorations(text: string): string {
  return text
    .replace(TIMESTAMP, ' ')
    .replace(SPEAKER_TAG, ' ')
    .replace(OWNER_NULL, ' ')
    .replace(CITATION, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function sanitizeMarkdown(markdown: string): string {
  return markdown
    .split(/\r?\n/u)
    .map((line) =>
      line
        .replace(TIMESTAMP, ' ')
        .replace(SPEAKER_TAG, ' ')
        .replace(OWNER_NULL, ' ')
        .replace(CITATION, ' ')
        .replace(/[ \t]+$/u, '')
        .replace(/[ \t]{2,}/gu, ' ')
    )
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

export function shapeIssues(markdown: string): string[] {
  const issues: string[] = []
  if (/Owner:\s*null/i.test(markdown)) issues.push('owner_null')
  if (/\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]/.test(markdown)) issues.push('timestamp')
  if (/\(src:|\[cite:/.test(markdown)) issues.push('citation')
  return issues
}
