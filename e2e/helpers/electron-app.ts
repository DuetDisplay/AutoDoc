import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { expect, type Page, _electron as electron } from '@playwright/test'
import type { E2EScenario } from '../../src/shared/e2e'
import type { OllamaSetupStatus, WhisperSetupStatus } from '../../src/shared/types'

async function launchApp(options: {
  scenario?: E2EScenario
  userDataDir?: string
  realSetup?: boolean
}) {
  const mainEntry = path.join(process.cwd(), 'out', 'main', 'index.js')
  expect(existsSync(mainEntry)).toBeTruthy()

  return electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ...(options.realSetup ? { AUTODOC_TEST_REAL_SETUP: '1' } : { AUTODOC_E2E: '1' }),
      ...(options.scenario ? { AUTODOC_E2E_SCENARIO: JSON.stringify(options.scenario) } : {}),
      ...(options.userDataDir ? { AUTODOC_TEST_USER_DATA_DIR: options.userDataDir } : {}),
    },
  })
}

export async function launchE2EApp(scenario?: E2EScenario) {
  return await launchApp({ scenario })
}

function killProcessesForUserDataDir(userDataDir: string): void {
  const terminatePid = (pid: number): void => {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }

    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already exited after SIGTERM.
    }
  }

  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `$path = ${JSON.stringify(userDataDir)}; ` +
          "Get-CimInstance Win32_Process -Filter \"Name = 'autodoc.exe'\" | " +
          "Where-Object { $_.CommandLine -like ('*' + $path + '*') } | " +
          'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ], { stdio: 'ignore' })
      return
    }

    const output = execFileSync('ps', ['eww', '-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    for (const pid of output
      .split(/\r?\n/)
      .filter((line) => line.includes(userDataDir))
      .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
      .filter(Boolean)) {
      terminatePid(pid)
    }
  } catch {}
}

export async function launchIsolatedE2EApp(scenario?: E2EScenario) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-e2e-isolated-'))
  const electronApp = await launchApp({ scenario, userDataDir })

  return {
    electronApp,
    userDataDir,
    async cleanup(): Promise<void> {
      try {
        await electronApp.close()
      } finally {
        killProcessesForUserDataDir(userDataDir)
        rmSync(userDataDir, { recursive: true, force: true })
      }
    },
  }
}

export async function launchRealSetupApp() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-real-setup-'))
  const electronApp = await launchApp({ realSetup: true, userDataDir })

  return {
    electronApp,
    userDataDir,
    async cleanup(): Promise<void> {
      try {
        await electronApp.close()
      } finally {
        killProcessesForUserDataDir(userDataDir)
        rmSync(userDataDir, { recursive: true, force: true })
      }
    },
  }
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

export async function jumpToOnboardingStep(page: Page, step: number): Promise<void> {
  await page.evaluate(async (nextStep) => {
    await window.electronAPI.invoke('prefs:set-onboarding-step', nextStep)
  }, step)
  await page.reload()
}

export async function completeOnboarding(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.electronAPI.invoke('prefs:set-onboarding-complete')
  })
  await page.reload()
}
