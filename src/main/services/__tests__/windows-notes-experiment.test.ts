import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeetingSegments, Segment } from '../../../shared/types'
import {
  countCompleteTightWriterItems,
  inspectCompactWriterPayload,
  OllamaProvider,
  shouldStopWindowsTightWriterStream
} from '../llm'
import {
  hasExactLosslessCoverage,
  presentMeetingSegmentsLosslessly
} from '../notes-lossless-presenter'
import {
  assignWindowsPresentationTopics,
  isWindowsTopicWriterEnabled,
  windowsNoteNeedsReview
} from '../windows-notes-experiment'
import {
  renderMeetingExportHtml,
  renderMeetingExportMarkdown,
  renderMeetingExportPlainText,
  type MeetingExportSnapshot
} from '../meeting-export'

const platform = process.platform
afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
})

function record(id: string, content: string, topic = 'Supplier renewal'): Segment {
  return {
    id,
    meetingId: 'test',
    category: 'information',
    title: content,
    content,
    topic,
    assignee: null,
    deadline: null,
    sourceStartMs: 1000,
    sourceEndMs: 2000
  }
}

function inventory(information: Segment[]): MeetingSegments {
  return { decisions: [], actionItems: [], information, discussion: [], statusUpdates: [] }
}

describe('Windows topic writer experiment', () => {
  it('is opt-in and cannot enable on macOS or Linux', () => {
    expect(isWindowsTopicWriterEnabled('win32', '1')).toBe(true)
    expect(isWindowsTopicWriterEnabled('win32', undefined)).toBe(false)
    expect(isWindowsTopicWriterEnabled('darwin', '1')).toBe(false)
    expect(isWindowsTopicWriterEnabled('darwin', 'lines')).toBe(false)
    expect(isWindowsTopicWriterEnabled('darwin', 'catalog')).toBe(false)
    expect(isWindowsTopicWriterEnabled('darwin', 'whole')).toBe(false)
    expect(isWindowsTopicWriterEnabled('darwin', 'wide')).toBe(false)
    expect(isWindowsTopicWriterEnabled('darwin', 'semantic')).toBe(false)
    expect(isWindowsTopicWriterEnabled('linux', '1')).toBe(false)
  })

  it('decodes and stops on three-field catalog records only in the Windows experiment', () => {
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'catalog')
    const sentence = 'The supplier offered a one-year renewal at the current price.'
    const payload = { i: [[sentence, 1, 2]] }
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    expect(inspectCompactWriterPayload(payload, true).expanded.information[0]).toMatchObject({
      title: sentence,
      content: sentence,
      sourceStartMs: 1,
      sourceEndMs: 2
    })
    expect(countCompleteTightWriterItems(JSON.stringify(payload).slice(0, -2))).toBe(1)
    const objects = { i: [{ c: sentence, s: 1, e: 2 }] }
    expect(inspectCompactWriterPayload(objects, true).expanded.information[0]).toMatchObject({
      title: sentence,
      content: sentence,
      sourceStartMs: 1,
      sourceEndMs: 2
    })
    expect(countCompleteTightWriterItems(JSON.stringify(objects).slice(0, -2))).toBe(1)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    expect(countCompleteTightWriterItems(JSON.stringify(payload))).toBe(0)
    expect(countCompleteTightWriterItems(JSON.stringify(objects))).toBe(0)
  })

  it('preserves multiple records sharing a topic and the original legacy tuple contract', () => {
    const input = {
      i: [
        ['Supplier renewal', 'The supplier accepted a one-year term.', 1000, 2000],
        ['Supplier renewal', 'The renewal price remains unchanged.', 3000, 4000]
      ]
    }
    const experiment = inspectCompactWriterPayload(input, true).expanded.information
    expect(experiment.map((item) => item.topic)).toEqual(['Supplier renewal', 'Supplier renewal'])
    expect(experiment[0]?.title).toBe('The supplier accepted a one-year term.')
    expect(experiment[1]?.title).toBe('The renewal price remains unchanged.')
    expect(inspectCompactWriterPayload(input).expanded.information[0]?.title).toBe(
      'Supplier renewal'
    )
    expect(
      inspectCompactWriterPayload(
        { i: [['Supplier renewal', 'The renewal price remains unchanged.']] },
        true
      ).expanded.information[0]
    ).toMatchObject({ topic: 'Supplier renewal', title: 'The renewal price remains unchanged.' })
  })

  it('accepts copied L-prefixed source IDs only in the Windows line-citation experiment', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'whole')
    const row = inspectCompactWriterPayload({i:[['Workshop', 'The workshop begins at ten AM.', 'L3', 'L4']]}, true).expanded.information[0]
    expect(row).toMatchObject({content:'The workshop begins at ten AM.',sourceStartMs:3,sourceEndMs:4})
  })

  it('keeps unrelated topics separate even at identical timestamps and beyond eight groups', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      record(`id-${i}`, `Department ${i} approved its schedule.`, `Department ${i}`)
    )
    const assigned = assignWindowsPresentationTopics(inventory(rows))
    expect(new Set(assigned.information.map((item) => item.topic)).size).toBe(10)
    expect(assigned.information.map((item) => item.id)).toEqual(rows.map((item) => item.id))
  })

  it('accepts normal Unicode and concrete feedback requests but does not resolve pronouns using arbitrary headings', () => {
    expect(windowsNoteNeedsReview(record('a', 'José will review the supplier contract.'))).toBe(
      false
    )
    expect(
      windowsNoteNeedsReview(record('b', 'We’ll deliver the revised schedule tomorrow.'))
    ).toBe(false)
    expect(
      windowsNoteNeedsReview(record('c', 'Give some feedback on the supplier contract by Friday.'))
    ).toBe(false)
    expect(windowsNoteNeedsReview(record('d', 'It increased significantly.', 'Other Notes'))).toBe(
      true
    )
  })

  it('uses one highlights area and preserves canonical records with source spans', () => {
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', '1')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const segments = inventory([
      record('a', 'The supplier accepted a one-year renewal at the current price.')
    ])
    const content = presentMeetingSegmentsLosslessly('test', segments)
    expect(content.keyTakeaways).toEqual([])
    expect(content.overview?.text).toContain('one-year renewal')
    expect(content.sections[0]?.title).toBe('Supplier renewal')
    expect(hasExactLosslessCoverage(segments, content)).toBe(true)
  })

  it('keeps the macOS prompt identical with the experiment switch on and off', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const provider = new OllamaProvider(
      'http://localhost:11435',
      'qwen3:4b-instruct'
    ) as unknown as { getSystemPrompt(): string }
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', '0')
    const original = provider.getSystemPrompt()
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', '1')
    expect(provider.getSystemPrompt()).toBe(original)
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
    expect(provider.getSystemPrompt()).toBe(original)
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'catalog')
    expect(provider.getSystemPrompt()).toBe(original)
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'whole')
    expect(provider.getSystemPrompt()).toBe(original)
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'wide')
    expect(provider.getSystemPrompt()).toBe(original)
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'semantic')
    expect(provider.getSystemPrompt()).toBe(original)
  })

  it.each([
    ['whole', true],
    ['whole', false],
    ['wide', true],
    ['wide', false]
  ] as const)('bounds the %s experiment by available memory: %s', async (mode, enoughMemory) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', mode)
    const provider = new OllamaProvider('http://localhost:11435', 'qwen3:4b-instruct')
    provider.setVramConstrainedContext(true, 'windows-cpu')
    const internals = provider as unknown as {
      getHostMemorySnapshot(): unknown
      callOllama(...args: unknown[]): Promise<string>
      getSystemPrompt(): string
      getMaxOutputTokens(): number
      contextTokens: number
    }
    vi.spyOn(internals, 'getHostMemorySnapshot').mockReturnValue({
      totalGiB: enoughMemory ? 32 : 8,
      freeGiB: enoughMemory ? 16 : 3
    })
    const requests: Array<{ context: unknown; limit: number; prompt: string }> = []
    vi.spyOn(internals, 'callOllama').mockImplementation(async (...args) => {
      requests.push({
        context: args[1],
        limit: internals.getMaxOutputTokens(),
        prompt: internals.getSystemPrompt()
      })
      return '{"i":[]}'
    })
    await provider.summarize(
      'test',
      Array.from(
        { length: 120 },
        () => '[00:01] [them] The supplier offered a one-year renewal at the current price.'
      ).join('\n')
    )
    expect(requests[0]?.context).toBe(enoughMemory ? (mode === 'whole' ? 32768 : 8192) : 4096)
    expect(requests[0]?.limit).toBe(enoughMemory ? (mode === 'whole' ? 3072 : 1536) : 768)
    if (enoughMemory) expect(requests).toHaveLength(1)
    else expect(requests.length).toBeGreaterThan(1)
    expect(internals.contextTokens).toBe(4096)
  })

  it('keeps the six-record default while allowing a bounded full-meeting call', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'whole')
    const raw = JSON.stringify({
      i: Array.from({ length: 6 }, () => ['Topic', 'Complete note.', 1, 2])
    })
    expect(shouldStopWindowsTightWriterStream(raw)).toBe(true)
    expect(shouldStopWindowsTightWriterStream(raw, 'win32', 32)).toBe(false)
  })

  it('maps Windows line citations through the grounded parser and rejects missing line IDs', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
    const provider = new OllamaProvider(
      'http://localhost:11435',
      'qwen3:4b-instruct'
    ) as unknown as {
      parseResponseWithStats(...args: unknown[]): {
        segments: MeetingSegments
        drops: Array<{ reason: string }>
      }
    }
    const sentence = 'The supplier accepted a one-year renewal.'
    const args = [
      undefined,
      60_000,
      [10_000],
      [{ startMs: 10_000, text: sentence }],
      new Map([[1, 10_000]])
    ]
    const good = provider.parseResponseWithStats(
      'test',
      JSON.stringify({ i: [['Supplier renewal', sentence, 1, 1]] }),
      ...args
    )
    expect(good.segments.information[0]).toMatchObject({
      topic: 'Supplier renewal',
      content: sentence,
      sourceStartMs: 10_000
    })
    const bad = provider.parseResponseWithStats(
      'test',
      JSON.stringify({ i: [['Supplier renewal', sentence, 99, 99]] }),
      ...args
    )
    expect(bad.segments.information).toEqual([])
    expect(bad.drops).toContainEqual(expect.objectContaining({ reason: 'invalid_citation' }))
  })

  it('removes identical title/body text in Windows exports without changing macOS exports', () => {
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
    const sentence = 'The supplier accepted the renewal.'
    const item = {
      id: 'a',
      title: sentence,
      text: sentence,
      topic: 'Supplier renewal',
      owner: null,
      deadline: null,
      sources: [],
      provenance: 'generated',
      legacySource: null
    }
    const snapshot = {
      detail: { title: 'Fixture', sourceName: null, date: 0, durationSeconds: 60 },
      notes: {
        overview: null,
        keyTakeaways: [],
        sections: [],
        decisions: [item],
        nextSteps: []
      }
    } as unknown as MeetingExportSnapshot
    for (const render of [
      renderMeetingExportHtml,
      renderMeetingExportMarkdown,
      renderMeetingExportPlainText
    ]) {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      expect(render(snapshot).split('The supplier accepted the renewal')).toHaveLength(2)
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
      expect(render(snapshot).split('The supplier accepted the renewal')).toHaveLength(3)
    }
  })

  it('keeps one exact record when repaired category paths ground into the same bucket', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
    const provider = new OllamaProvider(
      'http://localhost:11435',
      'qwen3:4b-instruct'
    ) as unknown as {
      parseResponseWithStats(...args: unknown[]): { segments: MeetingSegments }
    }
    const sentence = 'The supplier offered a one-year renewal at the current price.'
    const tuple = ['Supplier renewal', sentence, 1, 1]
    const result = provider.parseResponseWithStats(
      'test',
      JSON.stringify({ i: [tuple, 'd', [tuple]] }),
      undefined,
      60_000,
      [10_000],
      [{ startMs: 10_000, text: sentence }],
      new Map([[1, 10_000]])
    ).segments
    const records = Object.values(result).flat()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ content: sentence, sourceStartMs: 10_000 })
    expect(() => presentMeetingSegmentsLosslessly('test', result)).not.toThrow()
  })
})
