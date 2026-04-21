import { app } from 'electron'
import { join } from 'path'
import { MODELS_SUBDIR } from '../../shared/constants'

const CANONICAL_APP_DIR = 'AutoDoc'
const OLLAMA_DATA_SUBDIR = 'ollama-data'

export function shouldUseInstalledAppRuntimeFallback(): boolean {
  return (
    !app.isPackaged &&
    !process.env.AUTODOC_TEST_USER_DATA_DIR &&
    process.env.AUTODOC_E2E !== '1' &&
    process.env.AUTODOC_TEST_REAL_SETUP !== '1'
  )
}

export function getInstalledAppUserDataPath(): string | null {
  if (!shouldUseInstalledAppRuntimeFallback()) {
    return null
  }

  return join(app.getPath('appData'), CANONICAL_APP_DIR)
}

export function getInstalledModelsDir(): string | null {
  const userDataPath = getInstalledAppUserDataPath()
  return userDataPath ? join(userDataPath, MODELS_SUBDIR) : null
}

export function getInstalledOllamaDataDir(): string | null {
  const userDataPath = getInstalledAppUserDataPath()
  return userDataPath ? join(userDataPath, OLLAMA_DATA_SUBDIR) : null
}
