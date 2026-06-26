import { basename, posix, resolve, win32 } from 'path'
import { tmpdir } from 'os'

export interface ResetLocalDataOptions {
  userDataPath: string
  appDataPath: string
  testUserDataDir?: string
  isE2E?: boolean
  isRealSetupTest?: boolean
}

function normalizePath(targetPath: string): string {
  return resolve(targetPath)
}

function normalizePathForComparison(targetPath: string): string {
  return normalizePath(targetPath)
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
}

function isWithinTempDir(targetPath: string): boolean {
  const normalizedTarget = normalizePathForComparison(targetPath)
  const normalizedTmp = normalizePathForComparison(tmpdir())
  return normalizedTarget === normalizedTmp || normalizedTarget.startsWith(`${normalizedTmp}/`)
}

function joinAppDataPath(appDataPath: string, folderName: string): string {
  const joinPath = /^[A-Za-z]:/.test(appDataPath) || appDataPath.includes('\\')
    ? win32.join
    : posix.join
  return joinPath(appDataPath, folderName)
}

export function isSafeTestResetPath(targetPath: string): boolean {
  if (!isWithinTempDir(targetPath)) {
    return false
  }

  const folderName = basename(normalizePath(targetPath))
  return (
    folderName.startsWith('autodoc-e2e-')
    || folderName.startsWith('autodoc-e2e-isolated-')
    || folderName.startsWith('autodoc-real-setup-')
    || folderName.startsWith('autodoc-smoke-user-data-')
  )
}

export function getResetLocalDataTargets(options: ResetLocalDataOptions): string[] {
  const { userDataPath, appDataPath, testUserDataDir, isE2E, isRealSetupTest } = options
  const isTestReset = Boolean(testUserDataDir || isE2E || isRealSetupTest)

  if (isTestReset) {
    if (!isSafeTestResetPath(userDataPath)) {
      throw new Error(
        `Refusing to reset local data for a non-temporary test path: ${userDataPath}`,
      )
    }
    return [userDataPath]
  }

  return [...new Set([
    userDataPath,
    joinAppDataPath(appDataPath, 'AutoDoc'),
    joinAppDataPath(appDataPath, 'autodoc'),
    joinAppDataPath(appDataPath, 'Autodoc'),
  ])]
}
