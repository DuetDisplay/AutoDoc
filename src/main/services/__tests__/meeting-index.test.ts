import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { MeetingIndexService } from '../meeting-index'
import { setMainUiLanguage } from '../ui-locale'
import { buildRecordingTitle } from '../recording-title'

const tempDirs: string[] = []

afterEach(async () => {
  setMainUiLanguage('en')
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('MeetingIndexService', () => {
  it('refreshes cached search, meeting and inventory titles after a UI language change', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'autodoc-index-language-'))
    tempDirs.push(baseDir)
    const meetingDir = join(baseDir, 'synthetic')
    await mkdir(meetingDir)
    const startedAt = new Date(2026, 9, 28, 10).getTime()
    await writeFile(join(meetingDir, 'metadata.json'), JSON.stringify({ startedAt }))
    await writeFile(
      join(meetingDir, 'transcript.json'),
      JSON.stringify([
        { speaker: 'Mira', text: 'Synthetic launch planning', startMs: 0, endMs: 1000 }
      ])
    )
    const index = new MeetingIndexService(baseDir)
    setMainUiLanguage('en')
    const english = (await index.query('launch'))[0].title
    setMainUiLanguage('de')
    const german = buildRecordingTitle(null, startedAt, null)
    expect(german).not.toBe(english)
    expect((await index.getMeeting('synthetic'))?.title).toBe(german)
    expect((await index.query('launch'))[0].title).toBe(german)
    expect((await index.listInventory())[0].title).toBe(german)
  })

  it('returns an empty index for a missing folder and rethrows other directory errors', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'autodoc-index-errors-'))
    tempDirs.push(baseDir)
    expect(await new MeetingIndexService(join(baseDir, 'missing')).query('launch')).toEqual([])
    const file = join(baseDir, 'file')
    await writeFile(file, 'synthetic')
    await expect(new MeetingIndexService(file).query('launch')).rejects.toMatchObject({
      code: 'ENOTDIR'
    })
  })

  it('invalidates changed notes and inventory without retaining the prior ownership', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'autodoc-index-invalidation-'))
    tempDirs.push(baseDir)
    const meetingDir = join(baseDir, 'migration')
    await mkdir(meetingDir)
    const notesPath = join(meetingDir, 'notes.json')
    await writeFile(
      notesPath,
      JSON.stringify({
        schemaVersion: 2,
        overview: { text: 'Mira owns migration.', sources: [] },
        sections: [],
        keyTakeaways: [],
        decisions: [],
        nextSteps: []
      })
    )
    const index = new MeetingIndexService(baseDir)
    expect((await index.query('Mira'))[0]?.meetingId).toBe('migration')
    expect(await index.listInventory()).toHaveLength(1)
    await writeFile(
      notesPath,
      JSON.stringify({
        schemaVersion: 2,
        overview: { text: 'Sana now owns migration.', sources: [] },
        sections: [],
        keyTakeaways: [],
        decisions: [],
        nextSteps: []
      })
    )
    index.invalidate('migration')
    expect(await index.query('Mira')).toEqual([])
    expect((await index.query('Sana'))[0]?.meetingId).toBe('migration')
    const emptyDir = join(baseDir, 'empty-recording')
    await mkdir(emptyDir)
    index.invalidate()
    expect(await index.listInventory()).toHaveLength(2)
  })

  it('rescans correctly when the recursive watcher could not start', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'autodoc-index-no-watcher-'))
    tempDirs.push(parent)
    const baseDir = join(parent, 'not-created-yet')
    const index = new MeetingIndexService(baseDir)
    expect(await index.listInventory()).toEqual([])
    await mkdir(join(baseDir, 'later-recording'), { recursive: true })
    expect(await index.listInventory()).toHaveLength(1)
  })
  it('indexes V2 notes with source ranges and reuses them on a warm query', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'autodoc-meeting-index-'))
    tempDirs.push(baseDir)
    const meetingDir = join(baseDir, 'billing-sync')
    await mkdir(meetingDir)
    await writeFile(
      join(meetingDir, 'metadata.json'),
      JSON.stringify({ sourceName: 'Billing Sync', startedAt: new Date(2026, 4, 27, 10).getTime() })
    )
    await writeFile(
      join(meetingDir, 'notes.json'),
      JSON.stringify({
        schemaVersion: 2,
        overview: {
          text: 'The team aligned on billing migration.',
          sources: [{ startMs: 1_200, endMs: 4_000 }]
        },
        keyTakeaways: [
          {
            id: 't1',
            text: 'Ship the invoice export this week.',
            sources: [{ startMs: 84_000, endMs: 90_000 }]
          }
        ],
        sections: [],
        decisions: [],
        nextSteps: []
      })
    )

    const index = new MeetingIndexService(baseDir)
    const cold = await index.query('invoice export')
    expect(cold[0]?.matches[0]).toMatchObject({
      text: 'Key takeaway: Ship the invoice export this week.',
      startMs: 84_000
    })

    const meeting = await index.getMeeting('billing-sync')
    expect(meeting?.noteEntries.find((entry) => entry.id === 't1')?.sources[0]?.startMs).toBe(
      84_000
    )

    const warmStarted = Date.now()
    const warm = await index.query('invoice export')
    expect(Date.now() - warmStarted).toBeLessThan(50)
    expect(warm[0]?.meetingId).toBe('billing-sync')
  })

  it('falls back to segments.json when notes.json is missing', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'autodoc-meeting-index-'))
    tempDirs.push(baseDir)
    const meetingDir = join(baseDir, 'legacy')
    await mkdir(meetingDir)
    await writeFile(
      join(meetingDir, 'segments.json'),
      JSON.stringify({
        decisions: [],
        actionItems: [],
        information: [{ title: 'Legacy note', content: 'Keep the old CSV importer' }],
        discussion: [],
        statusUpdates: []
      })
    )

    const hits = await new MeetingIndexService(baseDir).query('CSV importer')
    expect(hits[0]?.matches.some((match) => match.text.includes('CSV importer'))).toBe(true)
  })
})
