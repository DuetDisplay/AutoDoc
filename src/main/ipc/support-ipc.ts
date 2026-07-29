import { app, ipcMain, shell } from 'electron'
import type { OpenSupportEmailResult } from '../../shared/types'
import {
  getSupportEmail,
  isOfficialAutoDocBuild,
  requireSupportEmail
} from '../services/distribution-config'
import { logAutodocEvent } from '../services/autodoc-log'

export function getSupportPlatformLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  return platform
}

export function buildSupportMailtoUrl(
  address: string,
  appVersion: string,
  platform: NodeJS.Platform
): string {
  const subject = `AutoDoc feedback — v${appVersion} — ${getSupportPlatformLabel(platform)}`
  return `mailto:${address}?subject=${encodeURIComponent(subject)}`
}

export function registerSupportIpc(): void {
  if (isOfficialAutoDocBuild()) {
    requireSupportEmail()
  }

  ipcMain.handle('support:get-availability', (): boolean => getSupportEmail() !== null)

  ipcMain.handle('support:open-email', async (): Promise<OpenSupportEmailResult> => {
    const address = getSupportEmail()
    const platform = process.platform
    if (!address) {
      logAutodocEvent({
        area: 'app',
        level: 'warn',
        message: 'support_email_unavailable',
        context: { platform }
      })
      return { status: 'unavailable' }
    }

    const mailtoUrl = buildSupportMailtoUrl(address, app.getVersion(), platform)
    try {
      await shell.openExternal(mailtoUrl)
      logAutodocEvent({
        area: 'app',
        message: 'support_email_draft_opened',
        context: { platform }
      })
      return { status: 'opened' }
    } catch {
      logAutodocEvent({
        area: 'app',
        level: 'warn',
        message: 'support_email_draft_open_failed',
        context: { platform }
      })
      return { status: 'copy-required', address }
    }
  })
}
