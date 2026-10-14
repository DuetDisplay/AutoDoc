import { access, copyFile, mkdir, readdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { setTimeout as delay } from 'timers/promises'

export const WINDOWS_ASSET_INSTALL_MARKER = '.autodoc-installing'
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 3000, 5000]
const LOCK_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST'])

export class WindowsAssetInstallError extends Error {
  constructor(filename: string, cause: unknown) {
    super(
      `Windows could not finish installing ${filename}. The verified download is saved. Try again shortly, or restart AutoDoc and retry.`,
      { cause }
    )
    this.name = 'WindowsAssetInstallError'
  }
}

export interface WindowsAssetInstallRetry {
  operation: string
  path: string
  attempt: number
  delayMs: number
  code: string
}

/** A marker survives failures/restarts so partial copies never count as installed. */
export async function isWindowsAssetInstallIncomplete(root: string): Promise<boolean> {
  try {
    await access(join(root, WINDOWS_ASSET_INSTALL_MARKER))
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * The staging directory has already passed archive SHA256 and contents checks.
 * Never remove an existing runtime: Windows may hold a handle to its directory.
 * If renaming a new directory is blocked, copy its files and publish completion
 * only after the entire copy succeeds. Retry individual locked files in place.
 */
export async function installWindowsTranscriptionAsset(
  stagedDir: string,
  targetDir: string,
  onRetry: (retry: WindowsAssetInstallRetry) => void
): Promise<void> {
  const retry = async (operation: string, path: string, action: () => Promise<unknown>) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await action()
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (!LOCK_ERRORS.has(code) || attempt >= RETRY_DELAYS_MS.length) throw error
        const delayMs = RETRY_DELAYS_MS[attempt]
        onRetry({ operation, path, attempt: attempt + 1, delayMs, code })
        await delay(delayMs)
      }
    }
  }

  try {
    await access(targetDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      await rename(stagedDir, targetDir)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!LOCK_ERRORS.has(code)) throw error
      onRetry({
        operation: 'rename directory; using file copy',
        path: targetDir,
        attempt: 1,
        delayMs: 0,
        code
      })
    }
  }

  await retry('create directory', targetDir, () => mkdir(targetDir, { recursive: true }))
  const marker = join(targetDir, WINDOWS_ASSET_INSTALL_MARKER)
  await retry('mark incomplete installation', marker, () => writeFile(marker, ''))

  const copyDirectory = async (source: string, destination: string): Promise<void> => {
    await retry('create directory', destination, () => mkdir(destination, { recursive: true }))
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name)
      const to = join(destination, entry.name)
      if (entry.isDirectory()) await copyDirectory(from, to)
      else if (entry.isFile()) await retry('copy file', to, () => copyFile(from, to))
      else throw new Error(`Unsupported entry in Windows transcription asset: ${entry.name}`)
    }
  }

  await copyDirectory(stagedDir, targetDir)
  await retry('publish completed installation', marker, () => rm(marker, { force: true }))
}
