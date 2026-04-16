import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page, _electron as electron } from '@playwright/test'
import type { E2EScenario } from '../../src/shared/e2e'
import type { OllamaSetupStatus, WhisperSetupStatus } from '../../src/shared/types'

export async function launchE2EApp(scenario?: E2EScenario) {
  const mainEntry = path.join(process.cwd(), 'out', 'main', 'index.js')
  expect(existsSync(mainEntry)).toBeTruthy()

  return electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AUTODOC_E2E: '1',
      AUTODOC_E2E_SCENARIO: scenario ? JSON.stringify(scenario) : '',
      NODE_ENV: 'test',
    },
  })
}

export async function stubMediaCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {},
      })
    }

    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error('E2E media capture is stubbed')
    }
  })
}

export async function setWhisperStatus(page: Page, status: WhisperSetupStatus): Promise<void> {
  await page.evaluate(async (nextStatus) => {
    await window.electronAPI.invoke('e2e:set-whisper-status', nextStatus)
  }, status)
}

export async function setOllamaStatus(page: Page, status: OllamaSetupStatus): Promise<void> {
  await page.evaluate(async (nextStatus) => {
    await window.electronAPI.invoke('e2e:set-ollama-status', nextStatus)
  }, status)
}
