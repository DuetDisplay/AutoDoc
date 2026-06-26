import { mkdtempSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    getPath: () => userDataDir
  }
}))

const captureError = vi.fn()

vi.mock('../sentry-reporter', () => ({
  captureError
}))

const {
  flushAutodocLogWrites,
  getAutodocLogPath,
  logAutodocFailure,
  setDiagnosticLogUploadForErrorsEnabled
} = await import('../autodoc-log')

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-log-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  captureError.mockReset()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('autodoc log', () => {
  beforeEach(() => {
    userDataDir = createTempDir()
    setDiagnosticLogUploadForErrorsEnabled(false)
  })

  it('records failures without attaching logs when diagnostic uploads are disabled', async () => {
    logAutodocFailure({
      area: 'app',
      message: 'controlled failure',
      error: new Error('boom'),
      context: {
        sourceName: 'Quarterly Planning',
        path: '/Users/tester/Documents/private.txt'
      }
    })

    await flushAutodocLogWrites()

    expect(captureError).toHaveBeenCalledTimes(1)
    expect(captureError.mock.calls[0]?.[1]?.diagnosticLogAttachment).toBeNull()

    const logContents = readFileSync(getAutodocLogPath(), 'utf-8')
    expect(logContents).toContain('"sourceName":null')
    expect(logContents).toContain('[home]')
    expect(logContents).not.toContain('/Users/tester')
  })

  it('attaches a sanitized diagnostic log tail when uploads are enabled', async () => {
    setDiagnosticLogUploadForErrorsEnabled(true)

    logAutodocFailure({
      area: 'app',
      message: 'controlled failure',
      error: new Error('boom'),
      context: {
        sourceName: 'Quarterly Planning',
        relevantWindowNames: ['Zoom | Secret'],
        access_token: 'abc123',
        email: 'qa@example.com',
        path: '/Users/tester/Documents/private.txt'
      }
    })

    await flushAutodocLogWrites()

    expect(captureError).toHaveBeenCalledTimes(1)
    const context = captureError.mock.calls[0]?.[1]
    expect(context?.diagnosticLogAttachment).toBeTruthy()
    expect(context?.diagnosticLogAttachment?.data).toContain('"sourceName":null')
    expect(context?.diagnosticLogAttachment?.data).toContain('"relevantWindowNames":[]')
    expect(context?.diagnosticLogAttachment?.data).toContain('[redacted]')
    expect(context?.diagnosticLogAttachment?.data).toContain('[home]')
    expect(context?.diagnosticLogAttachment?.data).not.toContain('qa@example.com')
    expect(context?.diagnosticLogAttachment?.data).not.toContain('/Users/tester')
  })
})
