import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { SpeechLicenseNotice } from '../../shared/speech-licenses'

/** Read the static package inventory generated from the packaged runtime(s). */
export async function speechRuntimeLicenseNotices(): Promise<SpeechLicenseNotice[]> {
  const path = app.isPackaged
    ? join(
        process.resourcesPath,
        'speech-runtime-licenses',
        `${process.platform}-${process.arch}.json`
      )
    : process.platform === 'win32'
      ? join(app.getAppPath(), 'resources', 'windows-speech-runtime-licenses.json')
      : join(
          app.getAppPath(),
          'vendor',
          'speech-runtime-licenses',
          `${process.platform}-${process.arch}.json`
        )
  const inventory = JSON.parse(await readFile(path, 'utf8'))
  return (process.platform === 'win32' ? inventory.notices : inventory) as SpeechLicenseNotice[]
}
