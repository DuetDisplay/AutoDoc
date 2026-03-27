import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'

const HELPER_RELATIVE_PATH = join('native', 'win-meeting-detector', 'bin', 'win-meeting-detector.exe')

let missingHelperLogged = false

export async function getActiveCaptureProcessIdsWindows(): Promise<string[]> {
  if (process.platform !== 'win32') return []

  const helperPath = resolveHelperPath()
  if (!helperPath) {
    if (!missingHelperLogged) {
      missingHelperLogged = true
      console.error('Windows meeting detector helper not found.')
    }
    return []
  }

  return new Promise((resolve) => {
    execFile(helperPath, { timeout: 2_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        console.error('Windows meeting detector helper failed:', error)
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
        console.error('Failed to parse Windows meeting detector output:', parseError)
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
