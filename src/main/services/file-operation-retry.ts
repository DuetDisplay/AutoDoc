import { rename, unlink } from 'fs/promises'

const WINDOWS_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])
const WINDOWS_RETRY_DELAYS_MS = [80, 160, 320, 640]

function isRetryableWindowsFileError(error: unknown): boolean {
  if (process.platform !== 'win32') {
    return false
  }

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''

  return WINDOWS_RETRYABLE_CODES.has(code)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown = null

  for (const delay of [0, ...WINDOWS_RETRY_DELAYS_MS]) {
    if (delay > 0) {
      await sleep(delay)
    }

    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!isRetryableWindowsFileError(error)) {
        throw error
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function replaceFileWithRetry(from: string, to: string): Promise<void> {
  for (const delay of [0, ...WINDOWS_RETRY_DELAYS_MS]) {
    if (delay > 0) {
      await sleep(delay)
    }

    try {
      await unlink(to).catch((error) => {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : ''
        if (code !== 'ENOENT') {
          throw error
        }
      })
      await rename(from, to)
      return
    } catch (error) {
      if (!isRetryableWindowsFileError(error)) {
        throw error
      }
    }
  }

  await renameWithRetry(from, to)
}
