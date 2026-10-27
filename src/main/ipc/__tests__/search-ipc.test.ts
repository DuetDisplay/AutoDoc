import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSearchIpc } from '../search-ipc'
import { setMainUiLanguage } from '../../services/ui-locale'
import { formatRecordingDateSuffix } from '../../services/recording-title'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const tempDirs: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../../services/calendar-matcher', () => ({
  readMetadata: vi.fn(async () => ({
    sourceName: 'Billing Sync',
    startedAt: new Date(2026, 4, 27, 10, 0).getTime()
  }))
}))

describe('registerSearchIpc', () => {
  it('reports filesystem failures instead of claiming that there are no matches', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'autodoc-search-failure-'))
    tempDirs.push(baseDir)
    const notADirectory = join(baseDir, 'not-a-recordings-directory')
    await writeFile(notADirectory, 'synthetic fixture')
    registerSearchIpc(notADirectory)
    await expect(handlers.get('search:query')?.({}, 'query')).rejects.toMatchObject({
      code: 'ENOTDIR'
    })
  })
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    setMainUiLanguage('en')
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    tempDirs.length = 0
  })

  it('matches V2 notes and skips stale writer extract text', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'autodoc-search-'))
    tempDirs.push(baseDir)
    const meetingDir = join(baseDir, 'billing-sync')
    await mkdir(meetingDir)
    await writeFile(
      join(meetingDir, 'segments.json'),
      JSON.stringify({
        decisions: [],
        actionItems: [],
        information: [
          {
            title: 'Writer extract',
            content: 'Legacy wording about the old CSV importer only.'
          }
        ],
        discussion: [],
        statusUpdates: []
      })
    )
    await writeFile(
      join(meetingDir, 'notes.json'),
      JSON.stringify({
        schemaVersion: 2,
        sections: [
          {
            title: 'Billing',
            keyPoints: [{ text: 'Move invoices onto the new export pipeline.' }]
          }
        ],
        nextSteps: []
      })
    )

    registerSearchIpc(baseDir)
    const results = (await handlers.get('search:query')?.({}, 'export pipeline')) as Array<{
      matches: Array<{ text: string }>
    }>

    expect(results[0].matches.some((match) => match.text.includes('export pipeline'))).toBe(true)

    const stale = (await handlers.get('search:query')?.({}, 'CSV importer')) as Array<{
      matches: Array<{ text: string }>
    }>
    expect(stale).toEqual([])
    setMainUiLanguage('ja')
    const localized = (await handlers.get('search:query')?.({}, 'export pipeline')) as Array<{
      title: string
    }>
    expect(localized[0].title).toBe(
      `Billing Sync — ${formatRecordingDateSuffix(new Date(2026, 4, 27, 10, 0).getTime(), 'ja')}`
    )
  })

  it('matches a V2 section heading that does not appear in the bullet text', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'autodoc-search-heading-'))
    tempDirs.push(baseDir)
    const meetingDir = join(baseDir, 'eng-sync')
    await mkdir(meetingDir)
    await writeFile(
      join(meetingDir, 'notes.json'),
      JSON.stringify({
        schemaVersion: 2,
        sections: [
          {
            title: 'Windows Tickets',
            keyPoints: [{ text: 'Accent keys fail during KMS on the host PC.' }]
          }
        ],
        nextSteps: []
      })
    )

    registerSearchIpc(baseDir)
    const results = (await handlers.get('search:query')?.({}, 'windows tickets')) as Array<{
      matches: Array<{ text: string }>
    }>

    expect(results[0].matches.some((match) => match.text.includes('Accent keys'))).toBe(true)
  })
})
