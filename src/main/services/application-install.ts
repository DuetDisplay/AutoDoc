import { execFile as execFileCallback, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { app, dialog } from 'electron'

const execFile = promisify(execFileCallback)
const APPLICATIONS_DIR = '/Applications'
const WINDOWS_UNINSTALL_PATHS = [
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
]

interface ResolvedApplication {
  containerPath: string
  executablePath: string
  version: string | null
}

interface InstalledApplication extends ResolvedApplication {
  launchPath: string
  locationLabel: string
}

interface SecondInstanceLaunchData {
  containerPath: string
  executablePath: string
  packaged: boolean
  platform: string
  version: string | null
}

let secondInstancePromptOpen = false

export function buildSingleInstanceLaunchData(platform: NodeJS.Platform = process.platform): Record<string, string | boolean | null> {
  const currentApplication = getCurrentApplication(platform)

  return {
    containerPath: currentApplication.containerPath,
    executablePath: currentApplication.executablePath,
    packaged: app.isPackaged,
    platform,
    version: currentApplication.version,
  }
}

export async function enforceInstalledApplicationPolicy(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!shouldEnforceInstalledCopyPolicy(platform)) {
    return true
  }

  const currentApplication = getCurrentApplication(platform)
  const installedApplication = await readInstalledApplication(platform)
  if (!installedApplication || sameApplicationCopy(currentApplication.containerPath, installedApplication.containerPath, platform)) {
    return true
  }

  if (compareVersionStrings(currentApplication.version ?? app.getVersion(), installedApplication.version) === 0) {
    return true
  }

  const userAcceptedReplacement = await promptForInstalledCopyReplacement({
    platform,
    sourceVersion: currentApplication.version ?? app.getVersion(),
    installedVersion: installedApplication.version,
    locationLabel: installedApplication.locationLabel,
  })
  if (!userAcceptedReplacement) {
    app.quit()
    return false
  }

  replaceInstalledCopyAndRelaunch(currentApplication, installedApplication, platform)
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

export async function handleSecondInstanceLaunch(additionalData: unknown, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!shouldEnforceInstalledCopyPolicy(platform) || secondInstancePromptOpen) {
    return false
  }

  const secondInstance = parseSecondInstanceLaunchData(additionalData)
  if (!secondInstance || secondInstance.packaged !== true || secondInstance.platform !== platform) {
    return false
  }

  const currentApplication = getCurrentApplication(platform)
  const installedApplication = await readInstalledApplication(platform)
  if (!installedApplication || !sameApplicationCopy(currentApplication.containerPath, installedApplication.containerPath, platform)) {
    return false
  }

  if (sameApplicationCopy(secondInstance.containerPath, currentApplication.containerPath, platform)) {
    return false
  }

  if (compareVersionStrings(secondInstance.version ?? app.getVersion(), installedApplication.version) === 0) {
    return false
  }

  secondInstancePromptOpen = true
  try {
    const userAcceptedReplacement = await promptForInstalledCopyReplacement({
      platform,
      sourceVersion: secondInstance.version ?? app.getVersion(),
      installedVersion: installedApplication.version,
      locationLabel: installedApplication.locationLabel,
    })
    if (!userAcceptedReplacement) {
      return false
    }

    const sourceApplication = await resolveSecondInstanceSource(secondInstance)
    if (!sourceApplication) {
      await showReplacementError(platform, new Error('Could not locate the launched AutoDoc copy to replace the installed version.'))
      return true
    }

    replaceInstalledCopyAndRelaunch(sourceApplication, installedApplication, platform)
    return true
  } finally {
    secondInstancePromptOpen = false
  }
}

function shouldEnforceInstalledCopyPolicy(platform: NodeJS.Platform): boolean {
  return app.isPackaged && (platform === 'darwin' || platform === 'win32')
}

function getCurrentApplication(platform: NodeJS.Platform): ResolvedApplication {
  const executablePath = app.getPath('exe')

  if (platform === 'darwin') {
    return {
      containerPath: getMacBundlePath(executablePath) ?? dirname(dirname(dirname(dirname(executablePath)))),
      executablePath,
      version: app.getVersion(),
    }
  }

  return {
    containerPath: dirname(executablePath),
    executablePath,
    version: app.getVersion(),
  }
}

async function readInstalledApplication(platform: NodeJS.Platform): Promise<InstalledApplication | null> {
  if (platform === 'darwin') {
    return readInstalledMacApplication()
  }
  if (platform === 'win32') {
    return readInstalledWindowsApplication()
  }
  return null
}

async function readInstalledMacApplication(): Promise<InstalledApplication | null> {
  const bundlePath = join(APPLICATIONS_DIR, `${app.getName()}.app`)
  const executablePath = join(bundlePath, 'Contents', 'MacOS', basename(app.getPath('exe')))

  try {
    await access(executablePath)
  } catch {
    return null
  }

  return {
    containerPath: bundlePath,
    executablePath,
    launchPath: bundlePath,
    locationLabel: '/Applications',
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

async function readInstalledWindowsApplication(): Promise<InstalledApplication | null> {
  const executableName = basename(app.getPath('exe'))
  const registryInstall = await readWindowsInstallFromRegistry(executableName)
  const candidates = [
    registryInstall,
    ...getWindowsInstallPathCandidates(executableName),
  ].filter((candidate): candidate is InstalledApplication => candidate !== null)

  const dedupedCandidates = candidates.filter((candidate, index) => (
    candidates.findIndex((existing) => sameApplicationCopy(existing.executablePath, candidate.executablePath, 'win32')) === index
  ))

  for (const candidate of dedupedCandidates) {
    try {
      await access(candidate.executablePath)
      return candidate
    } catch {
      continue
    }
  }

  return null
}

async function readWindowsInstallFromRegistry(executableName: string): Promise<InstalledApplication | null> {
  try {
    const script = [
      `$paths = @(${WINDOWS_UNINSTALL_PATHS.map((path) => `'${path}'`).join(', ')})`,
      `$entry = Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq '${escapePowerShellSingleQuotedString(app.getName())}' } | Select-Object -First 1 DisplayVersion, InstallLocation, DisplayIcon`,
      'if ($entry) { $entry | ConvertTo-Json -Compress }',
    ].join('; ')

    const { stdout } = await execFile('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], {
      encoding: 'utf8',
    })

    const trimmed = stdout.trim()
    if (!trimmed) return null

    const parsed = JSON.parse(trimmed) as {
      DisplayIcon?: string
      DisplayVersion?: string
      InstallLocation?: string
    }

    const displayIconPath = parseWindowsDisplayIconPath(parsed.DisplayIcon)
    const installRoot = parsed.InstallLocation?.trim()
      || (displayIconPath ? dirname(displayIconPath) : null)
    if (!installRoot) return null

    const executablePath = displayIconPath ?? join(installRoot, executableName)
    return {
      containerPath: installRoot,
      executablePath,
      launchPath: executablePath,
      locationLabel: 'the installed copy',
      version: parsed.DisplayVersion?.trim() || null,
    }
  } catch {
    return null
  }
}

function getWindowsInstallPathCandidates(executableName: string): InstalledApplication[] {
  const installRoots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', app.getName()) : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, app.getName()) : null,
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], app.getName()) : null,
  ].filter((candidate): candidate is string => Boolean(candidate))

  return installRoots.map((containerPath) => ({
    containerPath,
    executablePath: join(containerPath, executableName),
    launchPath: join(containerPath, executableName),
    locationLabel: 'the installed copy',
    version: null,
  }))
}

async function promptForInstalledCopyReplacement(options: {
  installedVersion: string | null
  locationLabel: string
  platform: NodeJS.Platform
  sourceVersion: string
}): Promise<boolean> {
  const { installedVersion, locationLabel, platform, sourceVersion } = options
  const versionComparison = compareVersionStrings(sourceVersion, installedVersion)
  const hasInstalledVersion = installedVersion !== null
  const isMac = platform === 'darwin'
  const comparisonTarget = isMac ? `the copy in ${locationLabel}` : locationLabel

  const title = hasInstalledVersion
    ? versionComparison > 0
      ? isMac ? 'Upgrade Applications Copy' : 'Upgrade Installed Copy'
      : isMac ? 'Downgrade Applications Copy' : 'Downgrade Installed Copy'
    : isMac ? 'Replace Applications Copy' : 'Replace Installed Copy'

  const message = hasInstalledVersion
    ? versionComparison > 0
      ? `AutoDoc ${sourceVersion} is newer than ${comparisonTarget} (${installedVersion}).`
      : `AutoDoc ${sourceVersion} is older than ${comparisonTarget} (${installedVersion}).`
    : isMac
      ? 'AutoDoc found another copy in /Applications, but could not read its version.'
      : 'AutoDoc found another installed copy, but could not read its version.'

  const detail = isMac
    ? 'Replace the AutoDoc copy in /Applications and relaunch from there so only one version can run.'
    : 'Replace the installed AutoDoc copy and relaunch from it so only one version can run.'

  const confirmLabel = hasInstalledVersion
    ? versionComparison > 0
      ? isMac ? 'Upgrade in Applications' : 'Upgrade Installed Copy'
      : isMac ? 'Downgrade in Applications' : 'Downgrade Installed Copy'
    : isMac ? 'Replace in Applications' : 'Replace Installed Copy'

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

async function resolveSecondInstanceSource(secondInstance: SecondInstanceLaunchData): Promise<ResolvedApplication | null> {
  try {
    await access(secondInstance.executablePath)
    return {
      containerPath: secondInstance.containerPath,
      executablePath: secondInstance.executablePath,
      version: secondInstance.version,
    }
  } catch {
    return null
  }
}

function parseSecondInstanceLaunchData(additionalData: unknown): SecondInstanceLaunchData | null {
  if (!additionalData || typeof additionalData !== 'object') {
    return null
  }

  const data = additionalData as Record<string, unknown>
  if (typeof data.containerPath !== 'string' || typeof data.executablePath !== 'string') {
    return null
  }

  return {
    containerPath: data.containerPath,
    executablePath: data.executablePath,
    packaged: data.packaged === true,
    platform: typeof data.platform === 'string' ? data.platform : '',
    version: typeof data.version === 'string' ? data.version : null,
  }
}

function sameApplicationCopy(leftPath: string, rightPath: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return normalizeWindowsPath(leftPath) === normalizeWindowsPath(rightPath)
  }

  return resolve(leftPath) === resolve(rightPath)
}

function normalizeWindowsPath(targetPath: string): string {
  return targetPath.replaceAll('/', '\\').toLowerCase()
}

function getMacBundlePath(executablePath: string): string | null {
  const match = executablePath.match(/^(.*?\.app)(?:\/Contents\/MacOS\/[^/]+)?$/)
  return match?.[1] ?? null
}

function parseWindowsDisplayIconPath(displayIcon: string | undefined): string | null {
  if (!displayIcon) return null

  const trimmed = displayIcon.trim()
  const withoutIndex = trimmed.replace(/,\d+$/, '')
  return withoutIndex.replace(/^"(.*)"$/, '$1')
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replaceAll("'", "''")
}

function replaceInstalledCopyAndRelaunch(
  sourceApplication: ResolvedApplication,
  installedApplication: InstalledApplication,
  platform: NodeJS.Platform,
): void {
  try {
    if (platform === 'darwin') {
      relaunchInstalledMacBundle(sourceApplication.containerPath, installedApplication.launchPath)
    } else if (platform === 'win32') {
      relaunchInstalledWindowsCopy(sourceApplication.containerPath, installedApplication.containerPath, installedApplication.launchPath)
    } else {
      return
    }
  } catch (error) {
    void showReplacementError(platform, error)
  }

  app.quit()
}

function relaunchInstalledMacBundle(sourceBundlePath: string, installedBundlePath: string): void {
  const stagedBundlePath = `${installedBundlePath}.codex-staged-${process.pid}`
  const backupBundlePath = `${installedBundlePath}.codex-backup-${process.pid}`
  const script = [
    'while kill -0 "$AUTODOC_PID" 2>/dev/null; do',
    '  sleep 1',
    'done',
    'rm -rf "$AUTODOC_TARGET_TMP" "$AUTODOC_TARGET_BACKUP"',
    '/usr/bin/ditto "$AUTODOC_SOURCE" "$AUTODOC_TARGET_TMP"',
    'if [ -d "$AUTODOC_TARGET" ]; then',
    '  /bin/mv "$AUTODOC_TARGET" "$AUTODOC_TARGET_BACKUP"',
    'fi',
    '/bin/mv "$AUTODOC_TARGET_TMP" "$AUTODOC_TARGET"',
    'rm -rf "$AUTODOC_TARGET_BACKUP"',
    '/usr/bin/open "$AUTODOC_TARGET"',
  ].join('\n')

  const child = spawn('/bin/sh', ['-c', script], {
    detached: true,
    env: {
      ...process.env,
      AUTODOC_PID: String(process.pid),
      AUTODOC_SOURCE: sourceBundlePath,
      AUTODOC_TARGET: installedBundlePath,
      AUTODOC_TARGET_BACKUP: backupBundlePath,
      AUTODOC_TARGET_TMP: stagedBundlePath,
    },
    stdio: 'ignore',
  })

  child.unref()
}

function relaunchInstalledWindowsCopy(sourceRoot: string, installedRoot: string, installedExecutablePath: string): void {
  const script = [
    '$pidToWait = [int]$env:AUTODOC_PID',
    'while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }',
    '$source = $env:AUTODOC_SOURCE',
    '$target = $env:AUTODOC_TARGET',
    '$targetExe = $env:AUTODOC_TARGET_EXE',
    '$null = robocopy $source $target /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP',
    'Start-Process -FilePath $targetExe',
  ].join('; ')

  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    detached: true,
    env: {
      ...process.env,
      AUTODOC_PID: String(process.pid),
      AUTODOC_SOURCE: sourceRoot,
      AUTODOC_TARGET: installedRoot,
      AUTODOC_TARGET_EXE: installedExecutablePath,
    },
    stdio: 'ignore',
  })

  child.unref()
}

async function showReplacementError(platform: NodeJS.Platform, error: unknown): Promise<void> {
  await dialog.showMessageBox({
    type: 'error',
    buttons: ['Quit'],
    defaultId: 0,
    cancelId: 0,
    title: platform === 'darwin' ? 'Could not replace Applications copy' : 'Could not replace installed copy',
    message: platform === 'darwin'
      ? 'AutoDoc could not replace the copy in /Applications.'
      : 'AutoDoc could not replace the installed copy.',
    detail: error instanceof Error ? error.message : 'Unknown installation error.',
  })
}
