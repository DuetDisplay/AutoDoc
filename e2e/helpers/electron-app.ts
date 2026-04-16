import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page, _electron as electron } from '@playwright/test'
import type { E2EScenario } from '../../src/shared/e2e'

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
