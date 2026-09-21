import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MeetingSegments, Segment } from '../../../shared/types'
import { applyWindowsOrganization, organizeWindowsNotes } from '../windows-notes-organization'
import { windowsRecoveryIsUsable } from '../windows-notes-experiment'
import { recoverExplicitTranscriptActions } from '../notes-explicit-action-recovery'
import { runNotesScanPipeline } from '../notes-scan-pipeline'
const originalPlatform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
})
afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})
function catalog(): MeetingSegments {
  const information: Segment[] = [
    'The library opens at ten AM.',
    'The budget remains at 350 dollars.'
  ].map((content, i) => ({
    id: String(i),
    meetingId: 'test',
    category: 'information',
    content,
    title: content,
    topic: 'Old topic',
    assignee: null,
    deadline: null,
    sourceStartMs: 1000 * i,
    sourceEndMs: 1000 * i
  }))
  return { information, decisions: [], actionItems: [], discussion: [], statusUpdates: [] }
}
it('changes only labels and source-checked overview, preserving every underlying record', () => {
  const input = catalog()
  const result = applyWindowsOrganization(
    JSON.stringify({
      groups: [
        { topic: 'Opening time', ids: [1] },
        { topic: 'Budget', ids: [2] }
      ],
      overview: [{ text: 'The library opens at ten AM.', ids: [1] }]
    }),
    input
  )
  expect(result.grouped).toBe(true)
  expect(result.overviewAccepted).toBe(true)
  expect(result.segments.information.map(({ topic: _, ...rest }) => rest)).toEqual(
    input.information.map(({ topic: _, ...rest }) => rest)
  )
  expect(result.overview?.sources).toEqual([{ startMs: 0, endMs: 0 }])
})
it.each([[1, 1], [1], [1, 3]])(
  'rejects missing, duplicated or invented catalog IDs: %j',
  (...ids) => {
    const input = catalog()
    expect(
      applyWindowsOrganization(
        JSON.stringify({ groups: [{ topic: 'Everything', ids }], overview: [] }),
        input
      ).grouped
    ).toBe(false)
  }
)
it('rejects invented summary quantities while retaining a valid grouping', () => {
  const result = applyWindowsOrganization(
    JSON.stringify({
      groups: [
        { topic: 'Opening', ids: [1] },
        { topic: 'Budget', ids: [2] }
      ],
      overview: [{ text: 'The budget increased to 900 dollars.', ids: [2] }]
    }),
    catalog()
  )
  expect(result.grouped).toBe(true)
  expect(result.overviewAccepted).toBe(false)
})
it('expands ordered topic transitions without asking the model to enumerate every ID', () => {
  const input = catalog()
  const result = applyWindowsOrganization(
    JSON.stringify({
      chapters: [
        { topic: 'Library opening', start: 1 },
        { topic: 'Budget', start: 2 }
      ],
      overview: []
    }),
    input
  )
  expect(result.grouped).toBe(true)
  expect(result.segments.information.map((row) => row.topic)).toEqual(['Library opening', 'Budget'])
  expect(result.segments.information.map((row) => row.id)).toEqual(
    input.information.map((row) => row.id)
  )
})
it.each([[2], [1, 1], [1, 3], [1, 2, 1]])('rejects invalid topic transitions: %j', (...starts) => {
  expect(
    applyWindowsOrganization(
      JSON.stringify({
        chapters: starts.map((start) => ({ topic: 'A subject', start })),
        overview: []
      }),
      catalog()
    ).grouped
  ).toBe(false)
})
it('adds no model call for a short meeting', async () => {
  const generate = vi.fn()
  await organizeWindowsNotes(catalog(), generate, 'test')
  expect(generate).not.toHaveBeenCalled()
})
it('renders a short semantic-experiment document once, without a copied overview', async () => {
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'semantic')
  const generate = vi.fn()
  const embed = vi.fn()
  const result = await runNotesScanPipeline(catalog(), {
    title: 'Library',
    meetingId: 'test',
    presentationMode: 'lossless',
    attributionTranscript: [],
    transcript: [],
    spanSources: [],
    generate,
    embed
  })
  expect(result.content.overview).toBeNull()
  expect(result.content.keyTakeaways).toEqual([])
  expect(
    result.content.sections.flatMap((section) => [
      ...section.keyPoints,
      ...section.supportingDetails
    ])
  ).toHaveLength(2)
  expect(generate).not.toHaveBeenCalled()
  expect(embed).not.toHaveBeenCalled()
})
it('names precomputed semantic groups without asking the model to assign every record', async () => {
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'semantic')
  const input = catalog()
  input.information = Array.from({ length: 9 }, (_, index) => ({
    ...input.information[0]!,
    id: String(index),
    sourceStartMs: index,
    sourceEndMs: index
  }))
  const embed = vi.fn(async () =>
    Array.from({ length: 9 }, (_, index) => [
      index < 3 ? 1 : 0.01,
      index >= 3 && index < 6 ? 1 : 0.01,
      index >= 6 ? 1 : 0.01
    ])
  )
  const generate = vi.fn(async () =>
    JSON.stringify({
      titles: ['Library schedule', 'Library budget', 'Library access'],
      summary: ''
    })
  )
  const result = await organizeWindowsNotes(input, generate, 'test', embed)
  expect(embed).toHaveBeenCalledTimes(1)
  expect(generate).toHaveBeenCalledTimes(1)
  expect(result.grouped).toBe(true)
  expect(result.segments.information.map((row) => row.id)).toEqual(
    input.information.map((row) => row.id)
  )
  expect(new Set(result.segments.information.map((row) => row.topic)).size).toBe(3)
})
it('separates current conversation management from future deliverables', () => {
  expect(windowsRecoveryIsUsable('Start with the quarterly budget.')).toBe(false)
  expect(windowsRecoveryIsUsable('Agree the research schedule and discuss the results.')).toBe(
    false
  )
  expect(windowsRecoveryIsUsable('Discuss the results with the supplier tomorrow.')).toBe(true)
  expect(windowsRecoveryIsUsable('Send the revised supplier contract by Friday.')).toBe(true)
})
it('does not add a second generic responsibility for the same named task and citation', () => {
  const segments = catalog()
  segments.information = []
  const content = 'Nora will recruit the remaining participants by Friday.'
  segments.actionItems = [
    {
      id: 'task',
      meetingId: 'test',
      category: 'action_item',
      content,
      title: content,
      topic: 'Recruitment',
      assignee: 'Nora',
      deadline: null,
      sourceStartMs: 1000,
      sourceEndMs: 2000
    }
  ]
  const rows = [
    {
      id: '1',
      meetingId: 'test',
      speaker: 'them',
      text: 'Nora, please recruit the remaining participants by Friday.',
      startMs: 1000,
      endMs: 1500,
      confidence: 1
    },
    {
      id: '2',
      meetingId: 'test',
      speaker: 'them',
      text: 'Nora will handle recruitment by Friday.',
      startMs: 2000,
      endMs: 2500,
      confidence: 1
    }
  ]
  expect(recoverExplicitTranscriptActions(segments, rows).segments.actionItems).toHaveLength(1)
})
