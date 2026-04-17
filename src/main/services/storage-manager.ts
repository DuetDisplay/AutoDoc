import { app } from 'electron'
import { lstat, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { MODELS_SUBDIR, PYTHON_ENV_SUBDIR, RECORDING_SUBDIR } from '../../shared/constants'
import type { AppStorageInfo } from '../../shared/types'

const LOGS_SUBDIR = 'logs'
const OLLAMA_DATA_SUBDIR = 'ollama-data'

export interface StoragePaths {
  userDataPath: string
  recordingsPath: string
  logsPath: string
  managedDownloadPaths: string[]
}

export function getStoragePaths(): StoragePaths {
  const userDataPath = app.getPath('userData')
  return {
    userDataPath,
    recordingsPath: join(userDataPath, RECORDING_SUBDIR),
    logsPath: join(userDataPath, LOGS_SUBDIR),
    managedDownloadPaths: [
      join(userDataPath, MODELS_SUBDIR),
      join(userDataPath, OLLAMA_DATA_SUBDIR),
      join(userDataPath, PYTHON_ENV_SUBDIR),
    ],
  }
}

async function getPathSize(targetPath: string): Promise<number> {
  let stats
  try {
    stats = await lstat(targetPath)
  } catch {
    return 0
  }

  if (!stats.isDirectory()) {
    return stats.size
  }

  let total = 0
  const entries = await readdir(targetPath)
  for (const entry of entries) {
    total += await getPathSize(join(targetPath, entry))
  }
  return total
}

export async function getAppStorageInfo(): Promise<AppStorageInfo> {
  const paths = getStoragePaths()
  const [recordingsBytes, logsBytes, totalBytes, ...managedSizes] = await Promise.all([
    getPathSize(paths.recordingsPath),
    getPathSize(paths.logsPath),
    getPathSize(paths.userDataPath),
    ...paths.managedDownloadPaths.map((targetPath) => getPathSize(targetPath)),
  ])

  const downloadedComponentsBytes = managedSizes.reduce((sum, size) => sum + size, 0)
  const otherLocalDataBytes = Math.max(
    0,
    totalBytes - downloadedComponentsBytes - recordingsBytes - logsBytes,
  )

  return {
    storagePath: paths.userDataPath,
    downloadedComponentsBytes,
    recordingsBytes,
    logsBytes,
    otherLocalDataBytes,
    totalBytes,
  }
}

export async function clearDownloadedComponents(): Promise<void> {
  const { managedDownloadPaths } = getStoragePaths()
  await Promise.all(
    managedDownloadPaths.map((targetPath) =>
      rm(targetPath, { recursive: true, force: true }),
    ),
  )
}
