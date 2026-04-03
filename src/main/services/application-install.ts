import { execFile as execFileCallback } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { app, dialog } from 'electron'

const execFile = promisify(execFileCallback)
const APPLICATIONS_DIR = '/Applications'

interface InstalledApplication {
  bundlePath: string
  executablePath: string
  version: string | null
}

export async function enforceMacOSInstallLocation(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) {
    return true
  }

  const installedApplication = await readInstalledApplication()
  if (installedApplication) {
    const versionComparison = compareVersionStrings(app.getVersion(), installedApplication.version)
    if (versionComparison === 0) {
      relaunchInstalledCopy(installedApplication.executablePath)
      return false
    }
  }

  const userAcceptedMove = await promptForApplicationsMove(installedApplication)
  if (!userAcceptedMove) {
    app.quit()
    return false
  }

  try {
    const moved = app.moveToApplicationsFolder({
      conflictHandler: () => true,
    })

    if (!moved) {
      app.quit()
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      buttons: ['Quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Could not move AutoDoc',
      message: 'AutoDoc could not move itself to /Applications.',
      detail: error instanceof Error ? error.message : 'Unknown installation error.',
    })
    app.quit()
  }

  return false
}

export function compareVersionStrings(currentVersion: string, installedVersion: string | null): number {
  if (!installedVersion) return 1

  const currentParts = normalizeVersion(currentVersion)
  const installedParts = normalizeVersion(installedVersion)
  const length = Math.max(currentParts.length, installedParts.length)

  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] ?? 0
    const installedPart = installedParts[index] ?? 0
    if (currentPart === installedPart) continue
    return currentPart > installedPart ? 1 : -1
  }

  return 0
}

function normalizeVersion(version: string): number[] {
  return version
    .split(/[.-]/)
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment))
}

async function readInstalledApplication(): Promise<InstalledApplication | null> {
  const bundlePath = join(APPLICATIONS_DIR, `${app.getName()}.app`)
  const executablePath = join(bundlePath, 'Contents', 'MacOS', basename(app.getPath('exe')))

  try {
    await access(executablePath)
  } catch {
    return null
  }

  return {
    bundlePath,
    executablePath,
    version: await readBundleVersion(bundlePath),
  }
}

async function readBundleVersion(bundlePath: string): Promise<string | null> {
  const infoPlistPath = join(bundlePath, 'Contents', 'Info.plist')

  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    try {
      const { stdout } = await execFile('/usr/bin/defaults', ['read', infoPlistPath, key], {
        encoding: 'utf8',
      })
      const version = stdout.trim()
      if (version) return version
    } catch {
      continue
    }
  }

  return null
}

async function promptForApplicationsMove(installedApplication: InstalledApplication | null): Promise<boolean> {
  const currentVersion = app.getVersion()
  const installedVersion = installedApplication?.version ?? null
  const versionComparison = compareVersionStrings(currentVersion, installedVersion)
  const hasInstalledCopy = installedApplication !== null
  const hasInstalledVersion = installedVersion !== null

  const title = hasInstalledVersion
    ? versionComparison > 0
      ? 'Upgrade Applications Copy'
      : 'Downgrade Applications Copy'
    : hasInstalledCopy
      ? 'Replace Applications Copy'
      : 'Move AutoDoc to Applications'

  const message = hasInstalledVersion
    ? versionComparison > 0
      ? `AutoDoc ${currentVersion} is newer than the copy in /Applications (${installedVersion}).`
      : `AutoDoc ${currentVersion} is older than the copy in /Applications (${installedVersion}).`
    : hasInstalledCopy
      ? 'AutoDoc found another copy in /Applications, but could not read its version.'
      : 'AutoDoc installs from /Applications.'

  const detail = hasInstalledCopy
    ? 'Move this copy into /Applications to keep one canonical install and avoid repeated macOS permission prompts.'
    : 'Running from a DMG or Downloads folder creates duplicate copies and can make macOS permissions behave inconsistently. Move AutoDoc to /Applications to continue.'

  const confirmLabel = hasInstalledVersion
    ? versionComparison > 0
      ? 'Upgrade in Applications'
      : 'Downgrade in Applications'
    : hasInstalledCopy
      ? 'Replace in Applications'
      : 'Move to Applications'

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [confirmLabel, 'Quit'],
    defaultId: 0,
    cancelId: 1,
    title,
    message,
    detail,
    noLink: true,
  })

  return response === 0
}

function relaunchInstalledCopy(executablePath: string): void {
  app.relaunch({ execPath: executablePath })
  app.quit()
}
