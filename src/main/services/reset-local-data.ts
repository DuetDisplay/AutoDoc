import { basename, join, resolve } from 'path'
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

function isWithinTempDir(targetPath: string): boolean {
  const normalizedTarget = normalizePath(targetPath)
  const normalizedTmp = `${normalizePath(tmpdir())}/`
  return normalizedTarget === normalizePath(tmpdir()) || normalizedTarget.startsWith(normalizedTmp)
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
    join(appDataPath, 'AutoDoc'),
    join(appDataPath, 'autodoc'),
    join(appDataPath, 'Autodoc'),
  ])]
}
