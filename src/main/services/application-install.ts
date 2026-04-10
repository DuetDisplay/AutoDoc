import { execFile as execFileCallback, execFileSync, spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { appendFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { app, dialog } from 'electron'

const execFile = promisify(execFileCallback)
const APPLICATIONS_DIR = '/Applications'
const INSTALL_POLICY_TRACE_ENABLED = process.env.AUTODOC_INSTALL_POLICY_TRACE === '1'
const INSTALL_POLICY_TRACE_FILE = process.env.AUTODOC_INSTALL_POLICY_TRACE_FILE || '/tmp/autodoc-install-policy.log'
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

interface WindowsReplacementOptions {
  terminateProcessIds?: number[]
  waitForProcessIds?: number[]
}

let secondInstancePromptOpen = false

export function traceInstallPolicy(message: string, data?: Record<string, unknown>): void {
  if (!INSTALL_POLICY_TRACE_ENABLED) return
  const timestamp = new Date().toISOString()
  const payload = data ? ` ${JSON.stringify(data)}` : ''
  try {
    appendFileSync(INSTALL_POLICY_TRACE_FILE, `[${timestamp}] ${message}${payload}\n`, 'utf8')
  } catch {
    // Trace logging is best-effort only.
  }
}

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
    traceInstallPolicy('enforce: skipped policy', { platform, packaged: app.isPackaged })
    return true
  }

  const currentApplication = getCurrentApplication(platform)
  const installedApplication = await readInstalledApplication(platform)
  traceInstallPolicy('enforce: resolved applications', {
    platform,
    currentContainer: currentApplication.containerPath,
    currentVersion: currentApplication.version,
    installedContainer: installedApplication?.containerPath ?? null,
    installedVersion: installedApplication?.version ?? null,
  })
  if (!installedApplication || sameApplicationCopy(currentApplication.containerPath, installedApplication.containerPath, platform)) {
    traceInstallPolicy('enforce: no installed conflict', {
      hasInstalled: Boolean(installedApplication),
      sameCopy: installedApplication ? sameApplicationCopy(currentApplication.containerPath, installedApplication.containerPath, platform) : null,
    })
    return true
  }

  if (compareVersionStrings(currentApplication.version ?? app.getVersion(), installedApplication.version) === 0) {
    traceInstallPolicy('enforce: same-version redirect', {
      source: currentApplication.containerPath,
      target: installedApplication.containerPath,
      version: currentApplication.version ?? app.getVersion(),
    })
    launchInstalledCopyAndQuit(installedApplication, platform)
    return false
  }

  const userAcceptedReplacement = await promptForInstalledCopyReplacement({
    platform,
    sourceVersion: currentApplication.version ?? app.getVersion(),
    installedVersion: installedApplication.version,
    locationLabel: installedApplication.locationLabel,
  })
  traceInstallPolicy('enforce: replacement prompt result', {
    accepted: userAcceptedReplacement,
    sourceVersion: currentApplication.version ?? app.getVersion(),
    installedVersion: installedApplication.version,
    platform,
  })
  if (!userAcceptedReplacement) {
    quitForInstalledCopyPolicy(platform)
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

export async function handleSecondInstanceLaunch(
  additionalData: unknown,
  argvOrPlatform: string[] | NodeJS.Platform = [],
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const argv = Array.isArray(argvOrPlatform) ? argvOrPlatform : []
  const resolvedPlatform = Array.isArray(argvOrPlatform) ? platform : argvOrPlatform

  if (!shouldEnforceInstalledCopyPolicy(resolvedPlatform) || secondInstancePromptOpen) {
    traceInstallPolicy('second-instance: ignored pre-check', {
      platform: resolvedPlatform,
      shouldEnforce: shouldEnforceInstalledCopyPolicy(resolvedPlatform),
      promptOpen: secondInstancePromptOpen,
    })
    return false
  }

  // Serialize handlers: a second `second-instance` must not run the pre-prompt `await` chain in parallel
  // or both can reach `promptForInstalledCopyReplacement` and the user sees duplicate dialogs.
  secondInstancePromptOpen = true
  try {
    const secondInstance = await resolveSecondInstanceLaunchData(additionalData, argv, resolvedPlatform)
    traceInstallPolicy('second-instance: resolved launch data', {
      platform: resolvedPlatform,
      argvCount: argv.length,
      secondContainer: secondInstance?.containerPath ?? null,
      secondExecutable: secondInstance?.executablePath ?? null,
      secondVersion: secondInstance?.version ?? null,
      secondPackaged: secondInstance?.packaged ?? null,
    })
    if (!secondInstance || secondInstance.packaged !== true || secondInstance.platform !== resolvedPlatform) {
      return false
    }

    const currentApplication = getCurrentApplication(resolvedPlatform)
    const installedApplication = await readInstalledApplication(resolvedPlatform)
    if (!installedApplication || !sameApplicationCopy(currentApplication.containerPath, installedApplication.containerPath, resolvedPlatform)) {
      traceInstallPolicy('second-instance: current copy is not installed target', {
        currentContainer: currentApplication.containerPath,
        installedContainer: installedApplication?.containerPath ?? null,
      })
      return false
    }

    if (sameApplicationCopy(secondInstance.containerPath, currentApplication.containerPath, resolvedPlatform)) {
      return false
    }

    if (
      secondInstance.version !== null
      && compareVersionStrings(secondInstance.version, installedApplication.version) === 0
    ) {
      return false
    }

    const sourceVersion = secondInstance.version
      ?? (await readPackagedApplicationVersion(secondInstance.containerPath, resolvedPlatform))
      ?? 'Unknown version'
    const userAcceptedReplacement = await promptForInstalledCopyReplacement({
      platform: resolvedPlatform,
      sourceVersion,
      installedVersion: installedApplication.version,
      locationLabel: installedApplication.locationLabel,
    })
    traceInstallPolicy('second-instance: replacement prompt result', {
      accepted: userAcceptedReplacement,
      sourceVersion,
      installedVersion: installedApplication.version,
      platform: resolvedPlatform,
    })
    if (!userAcceptedReplacement) {
      return false
    }

    const sourceApplication = await resolveSecondInstanceSource(secondInstance)
    if (!sourceApplication) {
      await showReplacementError(resolvedPlatform, new Error('Could not locate the launched AutoDoc copy to replace the installed version.'))
      return true
    }

    replaceInstalledCopyAndRelaunch(sourceApplication, installedApplication, resolvedPlatform)
    return true
  } finally {
    secondInstancePromptOpen = false
  }
}

export async function handleSingleInstanceLockFailure(_platform: NodeJS.Platform = process.platform): Promise<boolean> {
  // When a second process loses `requestSingleInstanceLock`, the first process receives
  // `second-instance` and must be the only one that shows install-policy UI. If we also
  // prompt from this process, Electron can show two identical dialogs (especially during
  // rapid re-launches or automated tests).
  traceInstallPolicy('single-instance lock failure: secondary instance exits without prompt', {
    platform: _platform,
  })
  return false
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
  const exeFromPath = basename(app.getPath('exe'))
  const bundleNames = Array.from(new Set([
    app.getName(),
    'AutoDoc',
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)))

  const executableNames = Array.from(new Set([exeFromPath, 'AutoDoc']))

  for (const bundleName of bundleNames) {
    const bundlePath = join(APPLICATIONS_DIR, `${bundleName}.app`)
    for (const executableName of executableNames) {
      const executablePath = join(bundlePath, 'Contents', 'MacOS', executableName)

      try {
        await access(executablePath)
      } catch {
        continue
      }

      traceInstallPolicy('mac installed candidate found', { bundlePath, executablePath })
      return {
        containerPath: bundlePath,
        executablePath,
        launchPath: bundlePath,
        locationLabel: '/Applications',
        version: await readBundleVersion(bundlePath),
      }
    }
  }

  traceInstallPolicy('mac installed candidate not found', { bundleNames, executableNames })
  return null
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

async function readFallbackWindowsSecondInstanceExecutablePath(): Promise<string | null> {
  const currentExecutablePath = app.getPath('exe')
  const executableName = basename(currentExecutablePath)
  const script = [
    `$processes = Get-CimInstance Win32_Process -Filter "Name = '${escapePowerShellSingleQuotedString(executableName)}'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath } | Select-Object -ExpandProperty ExecutablePath`,
    'if ($processes) { $processes | ConvertTo-Json -Compress }',
  ].join('; ')

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
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
      if (trimmed) {
        const parsed = JSON.parse(trimmed) as string | string[]
        const executablePaths = Array.isArray(parsed) ? parsed : [parsed]
        const candidate = executablePaths.find((value) => (
          typeof value === 'string'
          && normalizeWindowsPath(value) !== normalizeWindowsPath(currentExecutablePath)
        )) ?? null
        if (candidate) {
          return candidate
        }
      }
    } catch {
      // Keep polling briefly while the launched legacy process is still exiting.
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }

  return null
}

/**
 * When the user starts a second copy via `open`, argv may omit the .app path; scan `ps` for another
 * main AutoDoc binary (not Helper apps) like the Windows WMI fallback.
 */
async function readFallbackMacSecondInstanceExecutablePath(): Promise<string | null> {
  const currentExe = app.getPath('exe')
  const currentResolved = resolve(currentExe)
  const executableName = basename(currentExe)
  const tokenPattern = new RegExp(
    String.raw`(\/[^\s]+\/AutoDoc\.app\/Contents\/MacOS\/${escapeRegExp(executableName)})(?:\s|$)`,
    'g',
  )

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const { stdout } = await execFile('/bin/ps', ['-ax', '-o', 'args='], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      })

      const seen = new Set<string>()
      let match: RegExpExecArray | null
      const haystack = stdout
      tokenPattern.lastIndex = 0
      while ((match = tokenPattern.exec(haystack)) !== null) {
        const candidate = match[1]
        if (seen.has(candidate)) {
          continue
        }
        seen.add(candidate)

        try {
          if (resolve(candidate) === currentResolved) {
            continue
          }
          await access(candidate)
          return candidate
        } catch {
          continue
        }
      }
    } catch {
      // Ignore and retry while the second process may still be visible in ps.
    }

    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 100)
    })
  }

  return null
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

async function readWindowsInstallFromRegistry(executableName: string): Promise<InstalledApplication | null> {
  try {
    const script = [
      `$paths = @(${WINDOWS_UNINSTALL_PATHS.map((path) => `'${path}'`).join(', ')})`,
      `$entry = Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '${escapePowerShellSingleQuotedString(app.getName())}*' } | Select-Object -First 1 DisplayVersion, InstallLocation, DisplayIcon`,
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

async function resolveSecondInstanceLaunchData(
  additionalData: unknown,
  argv: string[],
  platform: NodeJS.Platform,
): Promise<SecondInstanceLaunchData | null> {
  const structuredData = parseSecondInstanceLaunchData(additionalData)
  if (structuredData) {
    if (structuredData.version === null && structuredData.packaged === true) {
      const inferredVersion = await readPackagedApplicationVersion(structuredData.containerPath, platform)
      if (inferredVersion) {
        return { ...structuredData, version: inferredVersion }
      }
    }
    return structuredData
  }

  if (platform === 'darwin') {
    let macExecutablePath = parseMacSecondInstanceExecutablePath(argv)
    traceInstallPolicy('second-instance: mac argv parse', {
      argvPreview: argv.slice(0, 4),
      parsedPath: macExecutablePath,
    })
    if (!macExecutablePath) {
      macExecutablePath = await readFallbackMacSecondInstanceExecutablePath()
      traceInstallPolicy('second-instance: mac ps fallback', {
        parsedPath: macExecutablePath,
      })
    }
    if (!macExecutablePath) {
      return null
    }

    try {
      await access(macExecutablePath)
    } catch {
      return null
    }

    const containerPath = getMacBundlePath(macExecutablePath)
    if (!containerPath) {
      return null
    }

    return {
      containerPath,
      executablePath: macExecutablePath,
      packaged: true,
      platform,
      version: await readPackagedApplicationVersion(containerPath, platform),
    }
  }

  if (platform !== 'win32') {
    return null
  }

  const fallbackExecutablePath = parseWindowsSecondInstanceExecutablePath(argv)
    ?? await readFallbackWindowsSecondInstanceExecutablePath()
  if (!fallbackExecutablePath) {
    return null
  }

  try {
    await access(fallbackExecutablePath)
  } catch {
    return null
  }

  return {
    containerPath: dirname(fallbackExecutablePath),
    executablePath: fallbackExecutablePath,
    packaged: true,
    platform,
    version: await readPackagedApplicationVersion(dirname(fallbackExecutablePath), platform),
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

async function replaceInstalledCopyAndRelaunch(
  sourceApplication: ResolvedApplication,
  installedApplication: InstalledApplication,
  platform: NodeJS.Platform,
  windowsOptions?: WindowsReplacementOptions,
): Promise<void> {
  try {
    if (platform === 'darwin') {
      relaunchInstalledMacBundle(sourceApplication.containerPath, installedApplication.launchPath)
    } else if (platform === 'win32') {
      await relaunchInstalledWindowsCopy(
        sourceApplication.containerPath,
        installedApplication.containerPath,
        installedApplication.launchPath,
        windowsOptions,
      )
    } else {
      return
    }
  } catch (error) {
    await showReplacementError(platform, error)
  }

  quitForInstalledCopyPolicy(platform)
}

async function readPackagedApplicationVersion(containerPath: string, platform: NodeJS.Platform): Promise<string | null> {
  const packageJsonPath = platform === 'darwin'
    ? join(containerPath, 'Contents', 'Resources', 'app.asar', 'package.json')
    : join(containerPath, 'resources', 'app.asar', 'package.json')

  try {
    const packageJson = await readFile(packageJsonPath, 'utf8')
    const parsed = JSON.parse(packageJson) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : null
  } catch {
    return null
  }
}

function parseWindowsSecondInstanceExecutablePath(argv: string[]): string | null {
  const expectedExecutableName = basename(app.getPath('exe')).toLowerCase()

  for (const value of argv) {
    if (typeof value !== 'string') continue

    const trimmed = value.trim().replace(/^"(.*)"$/, '$1')
    if (!trimmed.toLowerCase().endsWith('.exe')) continue
    if (basename(trimmed).toLowerCase() !== expectedExecutableName) continue

    return trimmed
  }

  return null
}

/** Second-instance argv on macOS often includes the loose copy's binary path; additionalData can be empty. */
function parseMacSecondInstanceExecutablePath(argv: string[]): string | null {
  const expectedExecutableName = basename(app.getPath('exe')).toLowerCase()

  for (const value of argv) {
    if (typeof value !== 'string') continue

    const trimmed = value.trim().replace(/^"(.*)"$/, '$1')
    const match = trimmed.match(/^(.*?\.app)\/Contents\/MacOS\/([^/]+)$/i)
    if (!match) continue
    if (match[2].toLowerCase() !== expectedExecutableName) continue
    return trimmed
  }

  return null
}

function relaunchInstalledMacBundle(sourceBundlePath: string, installedBundlePath: string): void {
  const stagedBundlePath = `${installedBundlePath}.codex-staged-${process.pid}`
  const backupBundlePath = `${installedBundlePath}.codex-backup-${process.pid}`
  const installedExePath = join(installedBundlePath, 'Contents', 'MacOS', 'AutoDoc')
  const script = [
    'while kill -0 "$AUTODOC_PID" 2>/dev/null; do',
    '  sleep 1',
    'done',
    // Kill any running instance from the installed location before replacing.
    // In the "warm" scenario another copy from /Applications is still alive.
    'pids=$(/bin/ps -axo pid=,args= | /usr/bin/grep -F "$AUTODOC_INSTALLED_EXE" | /usr/bin/awk \'{print $1}\' | /usr/bin/grep -v "^$$\\$")',
    'for p in $pids; do kill "$p" 2>/dev/null; done',
    'sleep 1',
    'for p in $pids; do kill -9 "$p" 2>/dev/null; done',
    'sleep 1',
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
      AUTODOC_INSTALLED_EXE: installedExePath,
      AUTODOC_SOURCE: sourceBundlePath,
      AUTODOC_TARGET: installedBundlePath,
      AUTODOC_TARGET_BACKUP: backupBundlePath,
      AUTODOC_TARGET_TMP: stagedBundlePath,
    },
    stdio: 'ignore',
  })

  child.unref()
}

async function relaunchInstalledWindowsCopy(
  sourceRoot: string,
  installedRoot: string,
  installedExecutablePath: string,
  options?: WindowsReplacementOptions,
): Promise<void> {
  const terminateProcessIds = Array.from(new Set(options?.terminateProcessIds?.filter((processId) => processId > 0) ?? []))
  const waitForProcessIds = Array.from(new Set(options?.waitForProcessIds?.filter((processId) => processId > 0) ?? [process.pid]))
  const helperBasePath = join(app.getPath('temp'), `autodoc-installed-copy-${process.pid}-${Date.now()}`)
  const scriptPath = `${helperBasePath}.ps1`
  const launcherPath = `${helperBasePath}.cmd`
  const logPath = `${helperBasePath}.log`
  const scheduledTaskName = `AutoDocInstalledCopy-${process.pid}-${Date.now()}`
  const script = `
param(
  [string]$Source,
  [string]$Target,
  [string]$TargetExe,
  [string]$TerminatePids,
  [string]$WaitPids,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'

function Get-DescendantProcessIds([int[]]$RootIds) {
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  if ($allProcesses.Count -eq 0) {
    return @()
  }

  $childrenByParent = @{}
  foreach ($process in $allProcesses) {
    if (-not $childrenByParent.ContainsKey($process.ParentProcessId)) {
      $childrenByParent[$process.ParentProcessId] = [System.Collections.Generic.List[int]]::new()
    }
    $childrenByParent[$process.ParentProcessId].Add([int]$process.ProcessId)
  }

  $pending = [System.Collections.Generic.Queue[int]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($rootId in $RootIds) {
    if ($rootId -gt 0 -and $seen.Add($rootId)) {
      $pending.Enqueue($rootId)
    }
  }

  while ($pending.Count -gt 0) {
    $current = $pending.Dequeue()
    if (-not $childrenByParent.ContainsKey($current)) {
      continue
    }

    foreach ($childId in $childrenByParent[$current]) {
      if ($childId -eq $PID) {
        continue
      }

      if ($seen.Add($childId)) {
        $pending.Enqueue($childId)
      }
    }
  }

  return @($seen)
}

function Parse-PidList([string]$RawValue) {
  if ([string]::IsNullOrWhiteSpace($RawValue)) {
    return @()
  }

  return @(
    $RawValue -split ',' |
      Where-Object { $_ } |
      ForEach-Object { [int]$_ } |
      Where-Object { $_ -gt 0 }
  )
}

try {
  $terminateRootIds = Parse-PidList $TerminatePids
  $waitRootIds = Parse-PidList $WaitPids
  $terminateIds = @(Get-DescendantProcessIds $terminateRootIds | Where-Object { $_ -ne $PID })
  $waitIds = @(Get-DescendantProcessIds $waitRootIds | Where-Object { $_ -ne $PID })

  if ($terminateIds.Count -gt 0) {
    Stop-Process -Id $terminateIds -Force -ErrorAction SilentlyContinue
  }

  if ($waitIds.Count -gt 0) {
    Wait-Process -Id $waitIds -ErrorAction SilentlyContinue
  }

  $null = robocopy $Source $Target /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed with exit code $LASTEXITCODE"
  }

  Start-Process -FilePath $TargetExe -WorkingDirectory (Split-Path -Parent $TargetExe)
} catch {
  $message = $_ | Out-String
  Set-Content -Path $LogPath -Value $message -Encoding UTF8
}
`.trim()
  const launcherScript = [
    '@echo off',
    [
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      quoteWindowsCommandArgument(scriptPath),
      '-Source',
      quoteWindowsCommandArgument(sourceRoot),
      '-Target',
      quoteWindowsCommandArgument(installedRoot),
      '-TargetExe',
      quoteWindowsCommandArgument(installedExecutablePath),
      '-TerminatePids',
      quoteWindowsCommandArgument(terminateProcessIds.join(',')),
      '-WaitPids',
      quoteWindowsCommandArgument(waitForProcessIds.join(',')),
      '-LogPath',
      quoteWindowsCommandArgument(logPath),
    ].join(' '),
    `schtasks /Delete /TN ${quoteWindowsCommandArgument(scheduledTaskName)} /F >nul 2>&1`,
  ].join('\r\n')

  writeFileSync(scriptPath, script, 'utf8')
  writeFileSync(launcherPath, launcherScript, 'utf8')

  execFileSync('schtasks.exe', [
    '/Create',
    '/TN',
    scheduledTaskName,
    '/SC',
    'ONCE',
    '/ST',
    formatScheduledTaskTime(),
    '/TR',
    `cmd.exe /d /c ${quoteWindowsCommandArgument(launcherPath)}`,
    '/F',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'ignore',
  })
  execFileSync('schtasks.exe', [
    '/Run',
    '/TN',
    scheduledTaskName,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'ignore',
  })
}

function launchInstalledCopyAndQuit(installedApplication: InstalledApplication, platform: NodeJS.Platform): void {
  try {
    if (platform === 'darwin') {
      spawn('/usr/bin/open', [installedApplication.launchPath], { detached: true, stdio: 'ignore' }).unref()
    } else if (platform === 'win32') {
      spawn(installedApplication.launchPath, [], {
        detached: true,
        stdio: 'ignore',
        cwd: dirname(installedApplication.launchPath),
      }).unref()
    }
  } catch {
    // If we can't launch the installed copy, fall through to quit silently.
  }

  quitForInstalledCopyPolicy(platform)
}

function quitForInstalledCopyPolicy(_platform: NodeJS.Platform): void {
  traceInstallPolicy('quitForInstalledCopyPolicy: calling app.exit(0)')
  app.exit(0)
  // app.exit(0) calls C exit() which should be immediate, but on macOS with
  // GPU/utility helper processes it can stall. Belt-and-suspenders:
  setTimeout(() => {
    traceInstallPolicy('quitForInstalledCopyPolicy: app.exit(0) did not terminate, forcing process.exit(0)')
    process.exit(0)
  }, 2000).unref()
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function formatScheduledTaskTime(date = new Date()): string {
  const scheduledDate = new Date(date.getTime() + 60_000)
  const hours = String(scheduledDate.getHours()).padStart(2, '0')
  const minutes = String(scheduledDate.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
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
