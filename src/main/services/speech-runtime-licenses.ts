import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { SpeechLicenseNotice } from '../../shared/speech-licenses'

/** Read the static package inventory generated from the packaged runtime(s). */
export async function speechRuntimeLicenseNotices(): Promise<SpeechLicenseNotice[]> {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'vendor')
  const path = join(root, 'speech-runtime-licenses', `${process.platform}-${process.arch}.json`)
  return JSON.parse(await readFile(path, 'utf8')) as SpeechLicenseNotice[]
}
