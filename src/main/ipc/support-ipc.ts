import { app, clipboard, ipcMain, shell, type WebContents } from 'electron'
import type {
  CopySupportEmailResult,
  OpenSupportEmailResult,
  SupportEmailSurface
} from '../../shared/types'
import {
  getSupportEmail,
  isOfficialAutoDocBuild,
  requireSupportEmail
} from '../services/distribution-config'
import { logAutodocEvent } from '../services/autodoc-log'

export const SUPPORT_EMAIL_SURFACES = [
  'sidebar',
  'onboarding',
  'upcoming',
  'ai_notes'
] as const satisfies readonly SupportEmailSurface[]

export interface RegisterSupportIpcOptions {
  isTrustedSender: (sender: WebContents) => boolean
  onContactInitiated?: (surface: SupportEmailSurface) => void | Promise<void>
}

const SUPPORT_EMAIL_BODY = [
  'What were you hoping AutoDoc would help with?',
  '',
  'What’s working well?',
  '',
  'What’s missing or getting in the way?'
].join('\n')

export function isSupportEmailSurface(value: unknown): value is SupportEmailSurface {
  return SUPPORT_EMAIL_SURFACES.some((surface) => surface === value)
}

export function getSupportPlatformLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  return platform
}

export function buildSupportMailtoUrl(
  address: string,
  appVersion: string,
  platform: NodeJS.Platform,
  surface: SupportEmailSurface = 'sidebar'
): string {
  const subject = `AutoDoc feedback — v${appVersion} — ${getSupportPlatformLabel(platform)}`
  const body =
    surface === 'upcoming' || surface === 'ai_notes'
      ? `&body=${encodeURIComponent(SUPPORT_EMAIL_BODY)}`
      : ''
  return `mailto:${address}?subject=${encodeURIComponent(subject)}${body}`
}

async function notifyContactInitiated(
  callback: RegisterSupportIpcOptions['onContactInitiated'],
  surface: SupportEmailSurface
): Promise<void> {
  if (!callback) return

  try {
    await callback(surface)
  } catch {
    logAutodocEvent({
      area: 'app',
      level: 'warn',
      message: 'support_contact_callback_failed',
      context: { platform: process.platform, surface }
    })
  }
}

export function registerSupportIpc(options: RegisterSupportIpcOptions): void {
  if (isOfficialAutoDocBuild()) {
    requireSupportEmail()
  }

  ipcMain.handle('support:get-availability', (event): boolean => {
    if (!options.isTrustedSender(event.sender)) return false
    return getSupportEmail() !== null
  })

  ipcMain.handle(
    'support:open-email',
    async (event, rawSurface: unknown): Promise<OpenSupportEmailResult> => {
      if (!options.isTrustedSender(event.sender)) return { status: 'unavailable' }

      if (!isSupportEmailSurface(rawSurface)) {
        logAutodocEvent({
          area: 'app',
          level: 'warn',
          message: 'support_email_invalid_surface',
          context: { platform: process.platform }
        })
        return { status: 'unavailable' }
      }

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

      const mailtoUrl = buildSupportMailtoUrl(address, app.getVersion(), platform, rawSurface)
      try {
        await shell.openExternal(mailtoUrl)
        await notifyContactInitiated(options.onContactInitiated, rawSurface)
        logAutodocEvent({
          area: 'app',
          message: 'support_email_draft_opened',
          context: { platform, surface: rawSurface }
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
    }
  )

  ipcMain.handle(
    'support:copy-email',
    async (event, rawSurface: unknown): Promise<CopySupportEmailResult> => {
      if (!options.isTrustedSender(event.sender)) return { status: 'unavailable' }

      if (!isSupportEmailSurface(rawSurface)) {
        logAutodocEvent({
          area: 'app',
          level: 'warn',
          message: 'support_email_copy_invalid_surface',
          context: { platform: process.platform }
        })
        return { status: 'unavailable' }
      }

      const address = getSupportEmail()
      const platform = process.platform
      if (!address) {
        logAutodocEvent({
          area: 'app',
          level: 'warn',
          message: 'support_email_copy_unavailable',
          context: { platform }
        })
        return { status: 'unavailable' }
      }

      try {
        clipboard.writeText(address)
      } catch {
        logAutodocEvent({
          area: 'app',
          level: 'warn',
          message: 'support_email_copy_failed',
          context: { platform, surface: rawSurface }
        })
        return { status: 'copy-failed' }
      }

      await notifyContactInitiated(options.onContactInitiated, rawSurface)
      logAutodocEvent({
        area: 'app',
        message: 'support_email_address_copied',
        context: { platform, surface: rawSurface }
      })
      return { status: 'copied' }
    }
  )
}
