import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const HELPER_RELATIVE_PATH = join('native', 'mac-meeting-detector', 'bin', 'mac-meeting-detector')

let missingHelperLogged = false

export async function getActiveCaptureProcessIdsMac(): Promise<string[]> {
  if (process.platform !== 'darwin') return []

  const helperPath = resolveHelperPath()
  if (!helperPath) {
    if (!missingHelperLogged) {
      missingHelperLogged = true
      console.error('macOS meeting detector helper not found.')
    }
    return []
  }

  return new Promise((resolve) => {
    execFile(helperPath, { timeout: 2_000 }, (error, stdout) => {
      if (error) {
        console.error('macOS meeting detector helper failed:', error)
        resolve([])
        return
      }

      try {
        const parsed = JSON.parse(stdout) as unknown
        if (Array.isArray(parsed)) {
          const ids = parsed.filter((value): value is string => typeof value === 'string')
          resolve(ids)
          return
        }
      } catch (parseError) {
        console.error('Failed to parse macOS meeting detector output:', parseError)
      }

      resolve([])
    })
  })
}

function resolveHelperPath(): string | null {
  const appPath = app.isReady() ? app.getAppPath() : process.cwd()
  const candidates = [
    join(process.cwd(), HELPER_RELATIVE_PATH),
    join(appPath, HELPER_RELATIVE_PATH),
    join(process.resourcesPath, 'app.asar.unpacked', HELPER_RELATIVE_PATH),
    join(process.resourcesPath, HELPER_RELATIVE_PATH),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}
