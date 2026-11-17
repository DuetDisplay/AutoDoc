/**
 * Ask AI improvement benchmark (AD-99 / AD-122 / AD-98).
 *
 * Compares the pre-change sequential decrypt search path against the shared
 * MeetingIndexService, and scores V2 source-range / citation accuracy.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatRecordingIndex } from '../../services/chat-retrieval'
import { MeetingIndexService } from '../../services/meeting-index'
import { applyAnswerCitations, numberSourceCards } from '../../services/ask-ai-citations'
import { collectNotesV2SearchEntries, matchNotesV2SearchEntries } from '../../services/notes-search-text'
import { decryptJSON, isEncrypted } from '../../services/crypto'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

vi.mock('../../services/calendar-matcher', async () => {
  const actual = await vi.importActual<typeof import('../../services/calendar-matcher')>(
    '../../services/calendar-matcher'
  )
  return {
    ...actual,
    readMetadata: vi.fn(async (meetingDir: string) => {
      const raw = await readFile(join(meetingDir, 'metadata.json'), 'utf-8').catch(() => null)
      return raw ? JSON.parse(raw) : null
    })
  }
})

describe('Ask AI improvement benchmark', () => {
  it('is faster on a warm V2 index and keeps timestamped, cite-locked evidence', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'autodoc-ask-ai-bench-'))
    tempDirs.push(baseDir)
    await seedLibrary(baseDir, 24)

    const sequentialCold = await timeAsync(() => sequentialSearch(baseDir, 'invoice export'))
    const sequentialRepeat = await timeAsync(() => sequentialSearch(baseDir, 'invoice export'))

    const index = new MeetingIndexService(baseDir)
    const indexCold = await timeAsync(() => index.query('invoice export'))
    const indexWarm = await timeAsync(() => index.query('invoice export'))

    const retrieval = new ChatRecordingIndex(baseDir, { meetingIndex: index })
    const asked = await timeAsync(() =>
      retrieval.buildContext('What was discussed about the invoice export?', [])
    )

    const sources = asked.value.sources ?? []
    const cited = applyAnswerCitations(
      'Priya owns the invoice export [1]. Legal never agreed [9].',
      numberSourceCards(
        sources.map(({ n: _n, ...card }) => card)
      )
    )

    const scorecard = {
      librarySize: 24,
      sequentialColdMs: sequentialCold.ms,
      sequentialRepeatMs: sequentialRepeat.ms,
      indexColdMs: indexCold.ms,
      indexWarmMs: indexWarm.ms,
      retrievalMs: asked.ms,
      warmSpeedup:
        sequentialRepeat.ms === 0 ? null : Number((sequentialRepeat.ms / Math.max(indexWarm.ms, 1)).toFixed(2)),
      sequentialHits: sequentialCold.value.length,
      indexHits: indexCold.value.length,
      sourceCount: sources.length,
      sourcesWithTimestamp: sources.filter((source) => source.startMs != null).length,
      retrievedBilling: asked.value.diagnostics.selectedMeetingIds.includes('meeting-3'),
      promptOmitsCiteBlock: !asked.value.context.includes('Cite claims'),
      citationStripsMarkers: !cited.answer.includes('[1]') && !cited.answer.includes('[9]'),
      chipsKeepRetrieved: cited.sources.length === sources.length
    }

    // eslint-disable-next-line no-console
    console.log('\n════════ Ask AI improvement benchmark ════════\n', scorecard)

    expect(indexCold.value.length).toBeGreaterThan(0)
    expect(indexWarm.ms).toBeLessThan(sequentialRepeat.ms)
    expect(asked.value.context).toContain('invoice export')
    expect(asked.value.context).not.toContain('Cite claims')
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.some((source) => source.startMs === 84_000)).toBe(true)
    expect(scorecard.promptOmitsCiteBlock).toBe(true)
    expect(scorecard.citationStripsMarkers).toBe(true)
    expect(scorecard.chipsKeepRetrieved).toBe(true)
    expect(scorecard.retrievedBilling).toBe(true)
  })
})

async function sequentialSearch(
  recordingsBaseDir: string,
  query: string
): Promise<Array<{ meetingId: string }>> {
  const terms = query.toLowerCase().split(/\s+/)
  const dirs = await (await import('fs/promises')).readdir(recordingsBaseDir)
  const hits: Array<{ meetingId: string }> = []
  for (const meetingId of dirs) {
    const meetingDir = join(recordingsBaseDir, meetingId)
    try {
      const nPath = join(meetingDir, 'notes.json')
      const notes = (await isEncrypted(nPath))
        ? await decryptJSON<unknown>(nPath)
        : JSON.parse(await readFile(nPath, 'utf-8'))
      const entries = collectNotesV2SearchEntries(notes)
      if (matchNotesV2SearchEntries(entries, terms).length > 0) hits.push({ meetingId })
    } catch {
      /* no notes */
    }
  }
  return hits
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now()
  const value = await fn()
  return { value, ms: Date.now() - started }
}

async function seedLibrary(baseDir: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const meetingId = `meeting-${i}`
    const meetingDir = join(baseDir, meetingId)
    await mkdir(meetingDir)
    const startedAt = new Date(2026, 4, 1 + i, 10).getTime()
    await writeFile(
      join(meetingDir, 'metadata.json'),
      JSON.stringify({
        sourceName: i === 3 ? 'Billing Sync' : `Standup ${i}`,
        startedAt
      })
    )
    await writeFile(
      join(meetingDir, 'notes.json'),
      JSON.stringify({
        schemaVersion: 2,
        overview: {
          text:
            i === 3
              ? 'The team aligned on billing migration and the invoice export.'
              : `Weekly status for workstream ${i}.`,
          sources: [{ startMs: 1_000, endMs: 4_000 }]
        },
        keyTakeaways: [
          {
            id: `t-${i}`,
            text:
              i === 3
                ? 'Ship the invoice export this week. Priya owns it.'
                : `No billing work in stream ${i}.`,
            sources: [{ startMs: i === 3 ? 84_000 : 8_000, endMs: 90_000 }]
          }
        ],
        sections: [],
        decisions: [],
        nextSteps: []
      })
    )
  }
}
