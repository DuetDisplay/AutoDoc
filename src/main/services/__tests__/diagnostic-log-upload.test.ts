import { mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDiagnosticLogAttachment, sanitizeDiagnosticLogTail } from '../diagnostic-log-upload'

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-diagnostic-log-upload-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('diagnostic log upload', () => {
  it('returns null when diagnostic log uploads are disabled', async () => {
    const dir = createTempDir()
    const logPath = path.join(dir, 'autodoc.log')
    writeFileSync(logPath, 'hello world\n', 'utf-8')

    await expect(buildDiagnosticLogAttachment(false, logPath)).resolves.toBeNull()
  })

  it('truncates and scrubs sensitive values from the attached tail', async () => {
    const dir = createTempDir()
    const logPath = path.join(dir, 'autodoc.log')
    const largePrefix = 'x'.repeat(70 * 1024)
    writeFileSync(
      logPath,
      `${largePrefix}\n` +
        '{"sourceName":"Quarterly Planning","relevantWindowNames":["Zoom | Secret"],"calendarTitle":"Roadmap","trackedSourceName":"Zoom Title","matchedTrackedSourceName":"Window Title"}\n' +
        'Bearer my-secret-token\n' +
        'access_token=abc123\n' +
        'owner jane@example.com\n' +
        'path=/Users/tester/Documents/private.txt\n',
      'utf-8'
    )

    const attachment = await buildDiagnosticLogAttachment(true, logPath)

    expect(attachment).not.toBeNull()
    expect(attachment?.filename).toBe('autodoc-diagnostic-tail.log')
    expect(Buffer.byteLength(attachment?.data ?? '', 'utf-8')).toBeLessThanOrEqual(64 * 1024)
    expect(attachment?.data).not.toContain('my-secret-token')
    expect(attachment?.data).not.toContain('abc123')
    expect(attachment?.data).not.toContain('jane@example.com')
    expect(attachment?.data).not.toContain('/Users/tester')
    expect(attachment?.data).toContain('[redacted]')
    expect(attachment?.data).toContain('[home]')
    expect(attachment?.data).toContain('"sourceName":null')
    expect(attachment?.data).toContain('"trackedSourceName":null')
    expect(attachment?.data).toContain('"matchedTrackedSourceName":null')
    expect(attachment?.data).toContain('"calendarTitle":null')
    expect(attachment?.data).toContain('"relevantWindowNames":[]')
  })

  it('limits the diagnostic tail by UTF-8 byte length', async () => {
    const dir = createTempDir()
    const logPath = path.join(dir, 'autodoc.log')
    writeFileSync(logPath, 'é'.repeat(40 * 1024), 'utf-8')

    const attachment = await buildDiagnosticLogAttachment(true, logPath)

    expect(attachment).not.toBeNull()
    expect(Buffer.byteLength(attachment?.data ?? '', 'utf-8')).toBeLessThanOrEqual(64 * 1024)
  })

  it('sanitizes sensitive inline values in log lines', () => {
    const sanitized = sanitizeDiagnosticLogTail(
      '{"title":"Confidential","sourceName":"Planning","path":"/Users/tester/work","email":"qa@example.com","access_token":"abc"}'
    )

    expect(sanitized).toContain('"title":null')
    expect(sanitized).toContain('"sourceName":null')
    expect(sanitized).toContain('"access_token":"[redacted]"')
    expect(sanitized).toContain('[home]')
    expect(sanitized).toContain('[redacted]')
    expect(sanitized).not.toContain('qa@example.com')
    expect(() => JSON.parse(sanitized)).not.toThrow()
  })

  it('sanitizes JSON-escaped Windows home paths in log lines', () => {
    const line = JSON.stringify({
      binaryPath: 'C:\\Users\\qa-user\\AppData\\Roaming\\AutoDoc\\ollama.exe'
    })

    const sanitized = sanitizeDiagnosticLogTail(line)
    const parsed = JSON.parse(sanitized) as { binaryPath: string }

    expect(sanitized).not.toContain('qa-user')
    expect(parsed.binaryPath).toBe('[home]\\AppData\\Roaming\\AutoDoc\\ollama.exe')
  })

  it('sanitizes Windows home paths with spaces and non-canonical Users casing', () => {
    const line = JSON.stringify({
      binaryPath: 'C:\\users\\QA User\\AppData\\Roaming\\AutoDoc\\ollama.exe'
    })

    const sanitized = sanitizeDiagnosticLogTail(line)
    const parsed = JSON.parse(sanitized) as { binaryPath: string }

    expect(sanitized).not.toContain('QA User')
    expect(parsed.binaryPath).toBe('[home]\\AppData\\Roaming\\AutoDoc\\ollama.exe')
  })
})
