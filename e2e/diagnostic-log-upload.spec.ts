import { readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedE2EAppWithEnv } from './helpers/electron-app'

async function readStubEnvelopes(stubPath: string) {
  const raw = await readFile(stubPath, 'utf-8')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
}

async function configureDiagnosticsConsent(
  page: Page,
  analyticsEnabled: boolean,
  diagnosticLogUploadEnabled: boolean
) {
  await page.evaluate(
    async ({ analyticsEnabled: nextAnalyticsEnabled, diagnosticLogUploadEnabled: nextLogUpload }) => {
      await window.electronAPI.invoke('prefs:set-analytics-consent', nextAnalyticsEnabled)
      await window.electronAPI.invoke(
        'prefs:set-diagnostic-log-upload-consent',
        nextLogUpload
      )
    },
    { analyticsEnabled, diagnosticLogUploadEnabled }
  )
}

test('reports errors without a log attachment when diagnostic log upload is off', async () => {
  const stubPath = path.join(
    os.tmpdir(),
    `autodoc-sentry-stub-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`
  )
  const session = await launchIsolatedE2EAppWithEnv({
    AUTODOC_SENTRY_DSN: 'https://stub@example.ingest.sentry.io/1',
    AUTODOC_SENTRY_STUB_PATH: stubPath
  })
  const page = await session.electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
    await configureDiagnosticsConsent(page, true, false)
    await page.evaluate(async () => {
      await window.electronAPI.invoke('e2e:trigger-main-error')
    })

    const envelopes = await readStubEnvelopes(stubPath)
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]?.type).toBe('exception')
    expect(envelopes[0]?.attachments ?? []).toHaveLength(0)
  } finally {
    await session.cleanup()
  }
})

test('attaches a sanitized diagnostic log tail when diagnostic log upload is on', async () => {
  const stubPath = path.join(
    os.tmpdir(),
    `autodoc-sentry-stub-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`
  )
  const session = await launchIsolatedE2EAppWithEnv({
    AUTODOC_SENTRY_DSN: 'https://stub@example.ingest.sentry.io/1',
    AUTODOC_SENTRY_STUB_PATH: stubPath
  })
  const page = await session.electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
    await configureDiagnosticsConsent(page, true, true)
    await page.evaluate(async () => {
      await window.electronAPI.invoke('e2e:trigger-main-error')
    })

    const envelopes = await readStubEnvelopes(stubPath)
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]?.type).toBe('exception')
    expect(envelopes[0]?.attachments ?? []).toHaveLength(1)

    const attachment = envelopes[0]?.attachments?.[0]
    expect(attachment?.filename).toBe('autodocLog-diagnostic-tail.log')
    expect(attachment?.data).toContain('[redacted]')
    expect(attachment?.data).toContain('[home]')
    expect(attachment?.data).toContain('"sourceName":null')
    expect(attachment?.data).toContain('"trackedSourceName":null')
    expect(attachment?.data).toContain('"relevantWindowNames":[]')
    expect(attachment?.data).not.toContain('jane@example.com')
    expect(attachment?.data).not.toContain('secret-token-value')
    expect(attachment?.data).not.toContain('/Users/tester')
  } finally {
    await session.cleanup()
  }
})
