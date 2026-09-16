import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { SegmentationService, shouldUseLosslessPresentation } from '../segmentation'
import type { LLMProvider } from '../llm'
import type { OllamaManager } from '../ollama-manager'
import { NotesRepository } from '../notes-repository'
import * as notesScanPipeline from '../notes-scan-pipeline'
import { computeLegacyNotesRevision } from '../notes-revision'
import { DEFAULT_OLLAMA_MODEL, LOW_SPEC_MAC_OLLAMA_MODEL } from '../../../shared/constants'

const mocks = vi.hoisted(() => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  lstat: vi.fn()
}))

vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptJSON: vi.fn(),
  encryptJSON: vi.fn()
}))

vi.mock('../autodoc-log', () => ({
  logAutodocEvent: mocks.logAutodocEvent,
  logAutodocFailure: mocks.logAutodocFailure
}))

const fsMock = vi.mocked(await import('fs/promises'))
const cryptoMock = vi.mocked(await import('../crypto'))

describe('shouldUseLosslessPresentation', () => {
  it('keeps macOS default-on with its rollback switch', () => {
    expect(shouldUseLosslessPresentation('darwin', {})).toBe(true)
    expect(shouldUseLosslessPresentation('darwin', { disableMac: '0' })).toBe(true)
    expect(shouldUseLosslessPresentation('darwin', { disableMac: '1' })).toBe(false)
  })

  it('keeps Windows default-on with its rollback switch', () => {
    expect(shouldUseLosslessPresentation('win32', {})).toBe(true)
    expect(shouldUseLosslessPresentation('win32', { disableWindows: '0' })).toBe(true)
    expect(shouldUseLosslessPresentation('win32', { disableWindows: '1' })).toBe(false)
  })

  it('leaves other platforms unchanged', () => {
    expect(shouldUseLosslessPresentation('linux', {})).toBe(false)
  })
})

function createMockProvider(): LLMProvider {
  return {
    summarize: vi.fn().mockResolvedValue({
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }),
    checkConnection: vi.fn().mockResolvedValue(true),
    abortActiveRequests: vi.fn(),
    setModel: vi.fn(),
    setLowMemoryMode: vi.fn(),
    releaseResources: vi.fn().mockResolvedValue(undefined),
    getLastWriterSkips: vi.fn().mockReturnValue([])
  }
}

function createMockOllamaManager(): OllamaManager {
  return {
    waitUntilReady: vi.fn().mockResolvedValue(undefined)
  } as unknown as OllamaManager
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SegmentationService', () => {
  let service: SegmentationService
  let provider: LLMProvider

  beforeEach(() => {
    vi.clearAllMocks()
    fsMock.unlink.mockResolvedValue(undefined as any)
    fsMock.lstat.mockRejectedValue({ code: 'ENOENT' })
    provider = createMockProvider()
    service = new SegmentationService(
      provider,
      createMockOllamaManager(),
      '/mock/home/AutoDoc/recordings'
    )
  })

  it.each(['win32', 'darwin'] as const)(
    'keeps notes memory evidence across a restart on %s',
    async (platform) => {
      const original = process.platform
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      const message =
        'Ollama returned 500: model requires more system memory (3.4 GiB) than is available (1.2 GiB)'
      const expected = {
        available: { value: 1.2, unit: 'GiB' },
        minimum: { value: 3.4, unit: 'GiB' }
      }
      const send = vi.fn()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ webContents: { send } }] as any)
      fsMock.readFile.mockResolvedValue(JSON.stringify({ error: message, retries: 3 }))
      try {
        expect(await service.getMemoryFailure('meeting-memory')).toEqual(expected)
        await (service as any).markFailed('meeting-memory', message)
        expect(send).toHaveBeenCalledWith(
          'segmentation:status-changed',
          expect.objectContaining({ status: 'failed', memoryFailure: expected })
        )
        fsMock.readFile.mockResolvedValue('Ollama returned 404: model not found')
        expect(await service.getMemoryFailure('meeting-other')).toBeUndefined()
      } finally {
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
        Object.defineProperty(process, 'platform', { value: original, configurable: true })
      }
    }
  )

  describe('Windows model readiness', () => {
    const originalPlatform = process.platform
    beforeEach(() =>
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    )
    afterEach(() =>
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    )

    it.each([false, true])(
      'reprepares a missing job model once, then succeeds or reports setup failure (persistent=%s)',
      async (persistent) => {
        const missing = new Error(
          'Ollama returned 404: {"error":"model \'qwen3:4b-instruct\' not found"}'
        )
        const readiness = {
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
          prepareModelForGeneration: vi.fn().mockResolvedValue(DEFAULT_OLLAMA_MODEL),
          isReadyForGeneration: vi.fn().mockResolvedValue(true),
          beginNotesGeneration: vi.fn(),
          endNotesGeneration: vi.fn().mockResolvedValue(undefined)
        }
        let boundModel = ''
        provider.setModel = vi.fn((model) => {
          boundModel = model
        })
        provider.getModel = () => boundModel
        service = new SegmentationService(provider, readiness, '/mock/home/AutoDoc/recordings')
        fsMock.access.mockResolvedValue(undefined)
        fsMock.readFile.mockResolvedValue(
          JSON.stringify([
            {
              id: 'row',
              meetingId: 'missing-model',
              speaker: 'me',
              text: 'We agreed to launch the customer portal on Friday.',
              startMs: 0,
              endMs: 5000,
              confidence: 1
            }
          ])
        )
        vi.spyOn(service as any, 'persistScanLayerNotes').mockResolvedValue({ notesLayout: 'v2' })
        if (persistent) vi.mocked(provider.summarize).mockRejectedValue(missing)
        else vi.mocked(provider.summarize).mockRejectedValueOnce(missing)
        const job = (service as any).processJob('missing-model')
        if (persistent) await expect(job).rejects.toThrow(/Ollama notes model setup failed/)
        else await job
        expect(readiness.prepareModelForGeneration).toHaveBeenCalledTimes(2)
        expect(provider.summarize).toHaveBeenCalledTimes(2)
        expect(readiness.isReadyForGeneration).toHaveBeenCalledWith(DEFAULT_OLLAMA_MODEL)
        expect(readiness.beginNotesGeneration).toHaveBeenCalledOnce()
        expect(readiness.endNotesGeneration).toHaveBeenCalledOnce()
        expect(readiness.endNotesGeneration.mock.invocationCallOrder[0]).toBeGreaterThan(
          vi.mocked(provider.releaseResources!).mock.invocationCallOrder.at(-1)!
        )
      }
    )

    it('binds an installed fallback returned by preparation instead of the preferred model', async () => {
      const readiness = {
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        prepareModelForGeneration: vi.fn().mockResolvedValue('llama3.1'),
        isReadyForGeneration: vi.fn().mockResolvedValue(true)
      }
      let boundModel = ''
      provider.setModel = vi.fn((model) => {
        boundModel = model
      })
      provider.getModel = () => boundModel
      service = new SegmentationService(provider, readiness, '/mock/home/AutoDoc/recordings')
      await (service as any).ensureOllamaReadyForGeneration('fallback', DEFAULT_OLLAMA_MODEL)
      expect(readiness.prepareModelForGeneration).toHaveBeenCalledWith(DEFAULT_OLLAMA_MODEL)
      expect(boundModel).toBe('llama3.1')
      expect(readiness.isReadyForGeneration).toHaveBeenCalledWith('llama3.1')
    })

    it('returns a missing scan model to preparation even when an optional pass swallows the error', async () => {
      const missing = new Error("Ollama returned 404: model 'qwen3:4b-instruct' not found")
      provider.completePrompt = vi.fn().mockRejectedValue(missing)
      fsMock.readFile.mockResolvedValue('{}')
      const pipeline = vi
        .spyOn(notesScanPipeline, 'runNotesScanPipeline')
        .mockImplementation(async (_segments, options) => {
          const request = {
            prompt: 'overview',
            num_ctx: 2048,
            num_predict: 128,
            temperature: 0,
            seed: 0,
            stop: []
          }
          await options.generate(request).catch(() => undefined)
          await options.generate(request).catch(() => undefined)
          return {} as Awaited<ReturnType<typeof notesScanPipeline.runNotesScanPipeline>>
        })
      try {
        const segments = {
          decisions: [],
          actionItems: [],
          information: [],
          discussion: [],
          statusUpdates: []
        }
        await expect(
          (service as any).persistScanLayerNotes('missing-scan', segments, [])
        ).rejects.toBe(missing)
        expect(provider.completePrompt).toHaveBeenCalledOnce()
      } finally {
        pipeline.mockRestore()
      }
    })

    it('does not automatically requeue a model setup failure, but permits an explicit retry', async () => {
      fsMock.readdir.mockResolvedValue(['model-setup'] as any)
      fsMock.stat.mockResolvedValue({ isDirectory: () => true } as any)
      fsMock.access.mockImplementation(async (path) => {
        if (String(path).endsWith('segments.json')) throw new Error('ENOENT')
      })
      fsMock.readFile.mockResolvedValue(
        JSON.stringify({
          error: 'Ollama notes model setup failed: offline',
          errorCode: 'ollama-model-setup',
          retries: 1,
          status: 'failed'
        })
      )
      const enqueue = vi.spyOn(service, 'enqueue').mockImplementation(() => {})
      await service.scanAndEnqueuePending()
      expect(enqueue).not.toHaveBeenCalled()
      service.retry('model-setup')
      expect(enqueue).toHaveBeenCalledWith('model-setup', 'direct')
    })
  })

  it('does not announce old notes as a completed Windows experimental regeneration after presentation fails', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
    const complete = vi.fn()
    service.onComplete(complete)
    const scan = vi.spyOn(service as any, 'persistScanLayerNotes').mockResolvedValue({ notesLayout: 'v1', errorCode: 'scan_or_persist', userReason: 'Could not update notes.' })
    const broadcast = vi.spyOn(service as any, 'broadcastStatus')
    fsMock.access.mockResolvedValue(undefined)
    fsMock.readFile.mockResolvedValue(JSON.stringify([{ id: 'row', meetingId: 'failure-case', speaker: 'them', text: 'The supplier renewed the agreement.', startMs: 0, endMs: 65000, confidence: 1 }]) as any)
    vi.mocked(provider.summarize).mockResolvedValue({ decisions: [], actionItems: [], discussion: [], statusUpdates: [], information: [{ id: 'note', meetingId: 'failure-case', category: 'information', title: 'Renewal', content: 'The supplier renewed the agreement.', topic: 'Contract', assignee: null, deadline: null, sourceStartMs: 0, sourceEndMs: 65000 }] })
    try {
      await (service as any).processJob('failure-case')
      expect(broadcast).toHaveBeenCalledWith('failure-case', 'failed', undefined, 'scan_or_persist', expect.any(Object))
      expect(complete).not.toHaveBeenCalled()
      expect(mocks.logAutodocEvent).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'notes generation completed' }))
    } finally {
      scan.mockRestore(); broadcast.mockRestore(); vi.unstubAllEnvs()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('persists the real Mac lossless path with full evidence and no scan model calls', async () => {
    const originalPlatform = process.platform
    const previousDisable = process.env.AUTODOC_DISABLE_MAC_LOSSLESS_NOTES
    const scanProvider = createMockProvider()
    const scanService = new SegmentationService(
      scanProvider,
      createMockOllamaManager(),
      '/mock/home/AutoDoc/recordings'
    )
    const promote = vi
      .spyOn(NotesRepository.prototype, 'promoteLegacyToV2')
      .mockResolvedValue({} as never)
    fsMock.readFile.mockRejectedValue({ code: 'ENOENT' } as any)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    delete process.env.AUTODOC_DISABLE_MAC_LOSSLESS_NOTES

    try {
      const segments = {
        decisions: [
          {
            id: 'decision-1',
            meetingId: 'meeting-mac-lossless',
            category: 'decision' as const,
            topic: 'Release',
            title: 'Hold release until QA clears',
            content: 'The release will wait until QA clears.',
            assignee: null,
            deadline: null,
            sourceStartMs: 3_000,
            sourceEndMs: 4_000
          }
        ],
        actionItems: [
          {
            id: 'action-1',
            meetingId: 'meeting-mac-lossless',
            category: 'action_item' as const,
            topic: 'Release',
            title: 'Send the QA estimate',
            content: 'Send the QA estimate when the build arrives.',
            assignee: null,
            deadline: 'When the build arrives',
            sourceStartMs: 1_000,
            sourceEndMs: 2_000
          }
        ],
        information: [],
        discussion: [],
        statusUpdates: []
      }
      const transcripts = [
        {
          id: 'transcript-1',
          meetingId: 'meeting-mac-lossless',
          speaker: 'me',
          text: "I'll send the QA estimate when the build arrives.",
          startMs: 1_100,
          endMs: 1_900,
          confidence: 1
        },
        {
          id: 'transcript-2',
          meetingId: 'meeting-mac-lossless',
          speaker: 'them',
          text: 'The release will wait until QA clears.',
          startMs: 3_100,
          endMs: 3_900,
          confidence: 1
        }
      ]

      const withDrafts = { ...segments, nextStepCandidates: [{
        ...segments.actionItems[0], id: 'rejected-draft', sourceStartMs: 90_000, sourceEndMs: 90_000
      }] }
      await scanService.saveSegments('meeting-mac-lossless', withDrafts)
      expect(cryptoMock.encryptJSON).toHaveBeenCalledWith(
        segments, join('/mock/home/AutoDoc/recordings', 'meeting-mac-lossless', 'segments.json')
      )
      const result = await (scanService as any).persistScanLayerNotes(
        'meeting-mac-lossless',
        withDrafts,
        transcripts
      )
      expect(promote.mock.calls[0][2].expectedLegacyRevision).toBe(
        computeLegacyNotesRevision('meeting-mac-lossless', segments)
      )

      expect(result).toEqual({ notesLayout: 'v2', groupingFallback: false })
      expect(scanProvider.completePrompt).toBeUndefined()
      expect(promote).toHaveBeenCalledTimes(1)
      const promotedContent = promote.mock.calls[0][1]
      expect(promotedContent.decisions).toEqual([])
      expect(promotedContent.nextSteps).toEqual([])
      expect(promotedContent.sections).toEqual([
        expect.objectContaining({
          title: 'Release',
          keyPoints: [
            expect.objectContaining({
              id: 'decision-1',
              text: 'The release will wait until QA clears.'
            })
          ]
        })
      ])
      expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'notes scan layer completed',
          context: expect.objectContaining({
            presentationMode: 'lossless',
            exactWriterCoverage: true,
            writerItemCount: 2,
            presentedItemCount: 1,
            attributionOwnersAdded: 0
          })
        })
      )
    } finally {
      promote.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (previousDisable == null) delete process.env.AUTODOC_DISABLE_MAC_LOSSLESS_NOTES
      else process.env.AUTODOC_DISABLE_MAC_LOSSLESS_NOTES = previousDisable
    }
  })

  it('persists the default Windows lossless path with full evidence and no scan model calls', async () => {
    const originalPlatform = process.platform
    const previousDisable = process.env.AUTODOC_DISABLE_WINDOWS_LOSSLESS_NOTES
    const scanProvider = createMockProvider()
    const scanService = new SegmentationService(
      scanProvider,
      createMockOllamaManager(),
      '/mock/home/AutoDoc/recordings'
    )
    const promote = vi
      .spyOn(NotesRepository.prototype, 'promoteLegacyToV2')
      .mockResolvedValue({} as never)
    fsMock.readFile.mockRejectedValue({ code: 'ENOENT' } as any)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    delete process.env.AUTODOC_DISABLE_WINDOWS_LOSSLESS_NOTES

    try {
      const segments = {
        decisions: [
          {
            id: 'decision-1',
            meetingId: 'meeting-win-lossless',
            category: 'decision' as const,
            topic: 'Release',
            title: 'Hold release until QA clears',
            content: 'The release will wait until QA clears.',
            assignee: null,
            deadline: null,
            sourceStartMs: 3_000,
            sourceEndMs: 4_000
          }
        ],
        actionItems: [
          {
            id: 'action-1',
            meetingId: 'meeting-win-lossless',
            category: 'action_item' as const,
            topic: 'Release',
            title: 'Send the QA estimate',
            content: 'Send the QA estimate when the build arrives.',
            assignee: null,
            deadline: 'When the build arrives',
            sourceStartMs: 1_000,
            sourceEndMs: 2_000
          }
        ],
        information: [],
        discussion: [],
        statusUpdates: []
      }
      const transcripts = [
        {
          id: 'transcript-1',
          meetingId: 'meeting-win-lossless',
          speaker: 'me',
          text: "I'll send the QA estimate when the build arrives.",
          startMs: 1_100,
          endMs: 1_900,
          confidence: 1
        },
        {
          id: 'transcript-2',
          meetingId: 'meeting-win-lossless',
          speaker: 'them',
          text: 'The release will wait until QA clears.',
          startMs: 3_100,
          endMs: 3_900,
          confidence: 1
        }
      ]

      const result = await (scanService as any).persistScanLayerNotes(
        'meeting-win-lossless',
        segments,
        transcripts
      )

      expect(result).toEqual({ notesLayout: 'v2', groupingFallback: false })
      expect(scanProvider.completePrompt).toBeUndefined()
      expect(promote).toHaveBeenCalledTimes(1)
      const promotedContent = promote.mock.calls[0][1]
      expect(promotedContent.decisions).toEqual([
        expect.objectContaining({
          id: 'decision-1',
          text: 'The release will wait until QA clears.'
        })
      ])
      expect(promotedContent.nextSteps).toEqual([])
      expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'notes scan layer completed',
          context: expect.objectContaining({
            presentationMode: 'lossless',
            exactWriterCoverage: true,
            writerItemCount: 2,
            presentedItemCount: 2,
            attributionOwnersAdded: 0
          })
        })
      )
    } finally {
      promote.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (previousDisable == null) delete process.env.AUTODOC_DISABLE_WINDOWS_LOSSLESS_NOTES
      else process.env.AUTODOC_DISABLE_WINDOWS_LOSSLESS_NOTES = previousDisable
    }
  })

  it('returns pending status when no files exist', async () => {
    fsMock.access.mockRejectedValue(new Error('ENOENT'))

    const status = await service.getStatus('meeting-123')
    expect(status).toBe('pending')
  })

  it('does not write legacy segments beneath authoritative V2 notes', async () => {
    fsMock.lstat.mockResolvedValue({ isFile: () => true } as any)

    await service.saveSegments('meeting-v2', {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    })

    expect(cryptoMock.encryptJSON).not.toHaveBeenCalled()
  })

  it('returns failed status when segments.error is newer than segments.json', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('segments.json') || String(path).endsWith('segments.error'))
        return undefined
      throw new Error('ENOENT')
    })
    fsMock.stat.mockImplementation(
      async (path) =>
        ({
          isDirectory: () => false,
          mtimeMs: String(path).endsWith('segments.error') ? 200 : 100
        }) as any
    )

    const status = await service.getStatus('meeting-123')
    expect(status).toBe('failed')
  })

  it('retry keeps the previous error marker until a new run succeeds', () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)

    service.retry('meeting-123')

    expect(fsMock.unlink).not.toHaveBeenCalled()
  })

  it('does not throw when marking a deleted meeting as failed', async () => {
    fsMock.readFile.mockRejectedValue(new Error('ENOENT'))
    fsMock.writeFile.mockRejectedValue({ code: 'ENOENT' } as any)

    await expect(
      (service as any).markFailed('deleted-meeting', 'This operation was aborted')
    ).resolves.toBeUndefined()
  })

  it('skips LLM summarization when transcript only contains low-signal boilerplate', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Speaker',
          text: 'Subtitles by the Amara.org community',
          startMs: 0,
          endMs: 1000,
          confidence: -1
        },
        {
          id: 'm1-1',
          meetingId: 'm1',
          speaker: 'Speaker',
          text: 'Thank you.',
          startMs: 1000,
          endMs: 2000,
          confidence: -1
        }
      ]) as any
    )

    await (service as any).processJob('m1')

    expect(provider.summarize).not.toHaveBeenCalled()
    expect(cryptoMock.encryptJSON).toHaveBeenCalledWith(
      {
        decisions: [],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      },
      join('/mock/home/AutoDoc/recordings', 'm1', 'segments.json')
    )
  })

  it('accepts empty segmentation output for short low-information transcripts', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Chris',
          text: 'We should probably follow up with them next week.',
          startMs: 0,
          endMs: 15_000,
          confidence: 0.8
        },
        {
          id: 'm1-1',
          meetingId: 'm1',
          speaker: 'Pat',
          text: 'Okay, let us regroup after we hear back.',
          startMs: 20_000,
          endMs: 55_000,
          confidence: 0.8
        }
      ]) as any
    )

    await expect((service as any).processJob('m1')).resolves.toBeUndefined()

    expect(provider.summarize).toHaveBeenCalled()
    expect(cryptoMock.encryptJSON).toHaveBeenCalledWith(
      {
        decisions: [],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      },
      join('/mock/home/AutoDoc/recordings', 'm1', 'segments.json')
    )
  })

  it('invokes onComplete when segmentation finishes successfully', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify([
          {
            id: 'm1-0',
            meetingId: 'm1',
            speaker: 'Chris',
            text: 'We confirmed the rollout plan.',
            startMs: 0,
            endMs: 65_000,
            confidence: 0.9
          }
        ])
      )
    )
    vi.mocked(provider.summarize).mockResolvedValue({
      decisions: [],
      actionItems: [],
      information: [
        {
          id: 'seg-1',
          meetingId: 'm1',
          category: 'information',
          topic: 'Rollout',
          title: 'Plan confirmed',
          content: 'The rollout plan was confirmed.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 65_000
        }
      ],
      discussion: [],
      statusUpdates: []
    })
    const onComplete = vi.fn()
    service.onComplete(onComplete)

    vi.mocked(provider.getLastWriterSkips!).mockReturnValue([
      { chunkIndex: 1, attempts: 2, rawHead: '{"decisions"', rawTail: 'na ' }
    ])

    await (service as any).processJob('m1')

    expect(onComplete).toHaveBeenCalledWith('m1')
    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'notes generation completed',
        meetingId: 'm1',
        context: expect.objectContaining({
          writerSkippedChunks: [
            { chunkIndex: 1, attempts: 2, rawHead: '{"decisions"', rawTail: 'na ' }
          ]
        })
      })
    )
  })

  it('keeps the LLM provider receiver when the scan layer starts', async () => {
    class ReceiverProvider {
      readonly activeControllers = new Set<string>()
      summarize = vi.fn().mockResolvedValue({
        decisions: [],
        actionItems: [],
        information: [
          {
            id: 'seg-1',
            meetingId: 'm1',
            category: 'information',
            topic: 'Rollout',
            title: 'Plan confirmed',
            content: 'The rollout plan was confirmed.',
            assignee: null,
            deadline: null,
            sourceStartMs: 0,
            sourceEndMs: 65_000
          }
        ],
        discussion: [],
        statusUpdates: []
      })
      checkConnection = vi.fn().mockResolvedValue(true)
      abortActiveRequests = vi.fn()
      setModel = vi.fn()
      setLowMemoryMode = vi.fn()
      releaseResources = vi.fn().mockResolvedValue(undefined)
      async completePrompt(this: ReceiverProvider) {
        this.activeControllers.add('scan')
        return ''
      }
    }
    const boundProvider = new ReceiverProvider()
    const pipeline = vi
      .spyOn(notesScanPipeline, 'runNotesScanPipeline')
      .mockImplementation(async (_segments, options) => {
        await options.generate({
          prompt: 'scan',
          num_ctx: 2048,
          num_predict: 64,
          temperature: 0,
          seed: 1,
          stop: []
        })
        expect(options.transcript?.length).toBeGreaterThan(0)
        expect(options.transcript?.[0]).toEqual({
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000
        })
        return {
          markdown: '',
          content: {
            overview: null,
            keyTakeaways: [],
            sections: [],
            decisions: [],
            nextSteps: []
          },
          groupingFallback: false,
          restyleFallbacks: 0,
          compressFallbacks: 0,
          restyleSkips: 0,
          compressSkips: 0,
          restyleRejectReasons: [],
          compressRejectReasons: [],
          attachFailed: false,
          overviewFailed: false,
          overviewFailureReasons: [],
          validation: {
            ran: false,
            error: null,
            ledgerChunksFailed: 0,
            claimsChecked: 0,
            claimsDropped: 0,
            ownersStripped: 0,
            ledgerAppends: 0,
            unvalidatedClaims: 0
          }
        }
      })
    const promote = vi
      .spyOn(NotesRepository.prototype, 'promoteLegacyToV2')
      .mockResolvedValue({} as never)

    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify([
          {
            id: 'm1-0',
            meetingId: 'm1',
            speaker: 'Chris',
            text: 'We confirmed the rollout plan.',
            startMs: 0,
            endMs: 65_000,
            confidence: 0.9
          }
        ])
      )
    )

    const boundService = new SegmentationService(
      boundProvider as unknown as LLMProvider,
      createMockOllamaManager(),
      '/mock/home/AutoDoc/recordings'
    )
    await (boundService as any).processJob('m1')

    expect(boundProvider.activeControllers.has('scan')).toBe(true)
    expect(pipeline).toHaveBeenCalled()
    expect(promote).toHaveBeenCalled()
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(boundProvider.releaseResources).toHaveBeenCalled()
      expect(boundProvider.releaseResources.mock.invocationCallOrder[0]).toBeGreaterThan(
        pipeline.mock.invocationCallOrder[0]
      )
    } else {
      expect(boundProvider.releaseResources).not.toHaveBeenCalled()
    }
    expect(mocks.logAutodocFailure).not.toHaveBeenCalled()

    pipeline.mockRestore()
    promote.mockRestore()
  })

  it('applies the cpu-constrained rewrite policy only when notes run on CPU', async () => {
    const previousTight = process.env.AUTODOC_TEST_NOTES_TIGHT
    const previousPolicy = process.env.AUTODOC_TEST_NOTES_SCAN_POLICY
    const previousSkip = process.env.AUTODOC_TEST_NOTES_SKIP_SCAN_REWRITES
    process.env.AUTODOC_TEST_NOTES_TIGHT = '0'
    delete process.env.AUTODOC_TEST_NOTES_SCAN_POLICY
    delete process.env.AUTODOC_TEST_NOTES_SKIP_SCAN_REWRITES
    try {
      const capturedPolicies: unknown[] = []
      const pipeline = vi
        .spyOn(notesScanPipeline, 'runNotesScanPipeline')
        .mockImplementation(async (_segments, options) => {
          capturedPolicies.push(options.rewritePolicy)
          return {
            markdown: '',
            content: {
              overview: null,
              keyTakeaways: [],
              sections: [],
              decisions: [],
              nextSteps: []
            },
            groupingFallback: false,
            restyleFallbacks: 0,
            compressFallbacks: 0,
            restyleSkips: 0,
            compressSkips: 0,
            restyleRejectReasons: [],
            compressRejectReasons: [],
            attachFailed: false,
            overviewFailed: false,
            overviewFailureReasons: [],
            validation: {
              ran: false,
              error: null,
              ledgerChunksFailed: 0,
              claimsChecked: 0,
              claimsDropped: 0,
              ownersStripped: 0,
              ledgerAppends: 0,
              unvalidatedClaims: 0
            }
          }
        })
      const promote = vi
        .spyOn(NotesRepository.prototype, 'promoteLegacyToV2')
        .mockResolvedValue({} as never)
      fsMock.access.mockImplementation(async (path) => {
        if (String(path).endsWith('transcript.json')) return undefined
        throw new Error('ENOENT')
      })
      fsMock.readFile.mockResolvedValue(
        JSON.stringify([
          {
            id: 'm1-0',
            meetingId: 'm1',
            speaker: 'Chris',
            text: 'We confirmed the rollout plan.',
            startMs: 0,
            endMs: 65_000,
            confidence: 0.9
          }
        ]) as any
      )

      const cases: { accelerator: 'cpu' | 'cuda' | 'vulkan'; measuredTokPerSec: number | null }[] =
        [
          { accelerator: 'cpu', measuredTokPerSec: null },
          { accelerator: 'cuda', measuredTokPerSec: null },
          { accelerator: 'cuda', measuredTokPerSec: 5 },
          { accelerator: 'cpu', measuredTokPerSec: 40 },
          { accelerator: 'vulkan', measuredTokPerSec: null }
        ]
      for (const { accelerator, measuredTokPerSec } of cases) {
        const scanProvider = createMockProvider()
        vi.mocked(scanProvider.summarize).mockResolvedValue({
          decisions: [],
          actionItems: [],
          information: [
            {
              id: 'seg-1',
              meetingId: 'm1',
              category: 'information',
              topic: 'Rollout',
              title: 'Plan confirmed',
              content: 'The rollout plan was confirmed.',
              assignee: null,
              deadline: null,
              sourceStartMs: 0,
              sourceEndMs: 65_000
            }
          ],
          discussion: [],
          statusUpdates: []
        })
        ;(scanProvider as { completePrompt?: unknown }).completePrompt = vi
          .fn()
          .mockResolvedValue('')
        if (measuredTokPerSec != null) {
          ;(scanProvider as { getLastEvalTokPerSec?: unknown }).getLastEvalTokPerSec = () =>
            measuredTokPerSec
        }
        const setVramConstrainedContext = vi.fn()
        ;(scanProvider as { setVramConstrainedContext?: unknown }).setVramConstrainedContext =
          setVramConstrainedContext
        const manager = {
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
          getNotesAccelerator: () => accelerator
        } as unknown as OllamaManager
        const scanService = new SegmentationService(
          scanProvider,
          manager,
          '/mock/home/AutoDoc/recordings'
        )
        await (scanService as any).processJob('m1')
        if (accelerator === 'vulkan') {
          expect(setVramConstrainedContext).toHaveBeenCalledWith(true, 'windows-vulkan')
        } else if (accelerator === 'cpu') {
          expect(setVramConstrainedContext).toHaveBeenCalledWith(true, 'windows-cpu')
        } else {
          expect(setVramConstrainedContext).toHaveBeenCalledWith(false)
        }
      }

      expect(capturedPolicies).toEqual([
        { maxAttemptsPerSection: 1, bailAfterConsecutiveRejects: 2 },
        undefined,
        { maxAttemptsPerSection: 1, bailAfterConsecutiveRejects: 2 },
        undefined,
        undefined
      ])

      pipeline.mockRestore()
      promote.mockRestore()
    } finally {
      if (previousTight == null) delete process.env.AUTODOC_TEST_NOTES_TIGHT
      else process.env.AUTODOC_TEST_NOTES_TIGHT = previousTight
      if (previousPolicy == null) delete process.env.AUTODOC_TEST_NOTES_SCAN_POLICY
      else process.env.AUTODOC_TEST_NOTES_SCAN_POLICY = previousPolicy
      if (previousSkip == null) delete process.env.AUTODOC_TEST_NOTES_SKIP_SCAN_REWRITES
      else process.env.AUTODOC_TEST_NOTES_SKIP_SCAN_REWRITES = previousSkip
    }
  })

  it('uses writer-weighted decode speed, not the last sample, for scan policy', async () => {
    const previousTight = process.env.AUTODOC_TEST_NOTES_TIGHT
    process.env.AUTODOC_TEST_NOTES_TIGHT = '0'
    const capturedPolicies: unknown[] = []
    const pipeline = vi
      .spyOn(notesScanPipeline, 'runNotesScanPipeline')
      .mockImplementation(async (_segments, options) => {
        capturedPolicies.push(options.rewritePolicy)
        return {
          markdown: '',
          content: {
            overview: null,
            keyTakeaways: [],
            sections: [],
            decisions: [],
            nextSteps: []
          },
          groupingFallback: false,
          restyleFallbacks: 0,
          compressFallbacks: 0,
          restyleSkips: 0,
          compressSkips: 0,
          restyleRejectReasons: [],
          compressRejectReasons: [],
          attachFailed: false,
          overviewFailed: false,
          overviewFailureReasons: [],
          validation: {
            ran: false,
            error: null,
            ledgerChunksFailed: 0,
            claimsChecked: 0,
            claimsDropped: 0,
            ownersStripped: 0,
            ledgerAppends: 0,
            unvalidatedClaims: 0
          }
        }
      })
    const promote = vi
      .spyOn(NotesRepository.prototype, 'promoteLegacyToV2')
      .mockResolvedValue({} as never)
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000,
          confidence: 0.9
        }
      ]) as any
    )
    const scanProvider = createMockProvider()
    vi.mocked(scanProvider.summarize).mockResolvedValue({
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    })
    ;(scanProvider as { completePrompt?: unknown }).completePrompt = vi.fn().mockResolvedValue('')
    ;(scanProvider as { getLastEvalTokPerSec?: unknown }).getLastEvalTokPerSec = () => 12.2
    ;(scanProvider as { getWriterWeightedEvalTokPerSec?: unknown }).getWriterWeightedEvalTokPerSec =
      () => 10.1
    try {
      const scanService = new SegmentationService(
        scanProvider,
        {
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
          getNotesAccelerator: () => 'cpu'
        } as unknown as OllamaManager,
        '/mock/home/AutoDoc/recordings'
      )
      await (scanService as any).processJob('m1')
      expect(capturedPolicies[0]).toEqual({
        maxAttemptsPerSection: 1,
        bailAfterConsecutiveRejects: 2
      })
    } finally {
      pipeline.mockRestore()
      promote.mockRestore()
      if (previousTight == null) delete process.env.AUTODOC_TEST_NOTES_TIGHT
      else process.env.AUTODOC_TEST_NOTES_TIGHT = previousTight
    }
  })

  it('honors AUTODOC_TEST_NOTES_SCAN_POLICY over measured speed', async () => {
    const previous = process.env.AUTODOC_TEST_NOTES_SCAN_POLICY
    const previousTight = process.env.AUTODOC_TEST_NOTES_TIGHT
    process.env.AUTODOC_TEST_NOTES_TIGHT = '0'
    process.env.AUTODOC_TEST_NOTES_SCAN_POLICY = 'cpu-constrained'
    const capturedPolicies: unknown[] = []
    const pipeline = vi
      .spyOn(notesScanPipeline, 'runNotesScanPipeline')
      .mockImplementation(async (_segments, options) => {
        capturedPolicies.push(options.rewritePolicy)
        return {
          markdown: '',
          content: {
            overview: null,
            keyTakeaways: [],
            sections: [],
            decisions: [],
            nextSteps: []
          },
          groupingFallback: false,
          restyleFallbacks: 0,
          compressFallbacks: 0,
          restyleSkips: 0,
          compressSkips: 0,
          restyleRejectReasons: [],
          compressRejectReasons: [],
          attachFailed: false,
          overviewFailed: false,
          overviewFailureReasons: [],
          validation: {
            ran: false,
            error: null,
            ledgerChunksFailed: 0,
            claimsChecked: 0,
            claimsDropped: 0,
            ownersStripped: 0,
            ledgerAppends: 0,
            unvalidatedClaims: 0
          }
        }
      })
    const promote = vi
      .spyOn(NotesRepository.prototype, 'promoteLegacyToV2')
      .mockResolvedValue({} as never)
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000,
          confidence: 0.9
        }
      ]) as any
    )
    try {
      const scanProvider = createMockProvider()
      vi.mocked(scanProvider.summarize).mockResolvedValue({
        decisions: [],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      })
      ;(scanProvider as { completePrompt?: unknown }).completePrompt = vi.fn().mockResolvedValue('')
      ;(scanProvider as { getLastEvalTokPerSec?: unknown }).getLastEvalTokPerSec = () => 40
      ;(
        scanProvider as { getWriterWeightedEvalTokPerSec?: unknown }
      ).getWriterWeightedEvalTokPerSec = () => 40
      const scanService = new SegmentationService(
        scanProvider,
        {
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
          getNotesAccelerator: () => 'cuda'
        } as unknown as OllamaManager,
        '/mock/home/AutoDoc/recordings'
      )
      await (scanService as any).processJob('m1')
      expect(capturedPolicies[0]).toEqual({
        maxAttemptsPerSection: 1,
        bailAfterConsecutiveRejects: 2
      })
    } finally {
      if (previous == null) delete process.env.AUTODOC_TEST_NOTES_SCAN_POLICY
      else process.env.AUTODOC_TEST_NOTES_SCAN_POLICY = previous
      if (previousTight == null) delete process.env.AUTODOC_TEST_NOTES_TIGHT
      else process.env.AUTODOC_TEST_NOTES_TIGHT = previousTight
      pipeline.mockRestore()
      promote.mockRestore()
    }
  })

  it('skips scan restyle and compress for Windows tight notes', async () => {
    const previousTight = process.env.AUTODOC_TEST_NOTES_TIGHT
    const previousPolicy = process.env.AUTODOC_TEST_NOTES_SCAN_POLICY
    delete process.env.AUTODOC_TEST_NOTES_TIGHT
    delete process.env.AUTODOC_TEST_NOTES_SCAN_POLICY
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const capturedPolicies: unknown[] = []
    const capturedPresentationModes: unknown[] = []
    const pipeline = vi
      .spyOn(notesScanPipeline, 'runNotesScanPipeline')
      .mockImplementation(async (_segments, options) => {
        capturedPolicies.push(options.rewritePolicy)
        capturedPresentationModes.push(options.presentationMode)
        return {
          markdown: '',
          content: {
            overview: null,
            keyTakeaways: [],
            sections: [],
            decisions: [],
            nextSteps: []
          },
          groupingFallback: false,
          restyleFallbacks: 0,
          compressFallbacks: 0,
          restyleSkips: 0,
          compressSkips: 0,
          restyleRejectReasons: [],
          compressRejectReasons: [],
          attachFailed: false,
          overviewFailed: false,
          overviewFailureReasons: [],
          validation: {
            ran: false,
            error: null,
            ledgerChunksFailed: 0,
            claimsChecked: 0,
            claimsDropped: 0,
            ownersStripped: 0,
            ledgerAppends: 0,
            unvalidatedClaims: 0
          }
        }
      })
    const promote = vi
      .spyOn(NotesRepository.prototype, 'promoteLegacyToV2')
      .mockResolvedValue({} as never)
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000,
          confidence: 0.9
        }
      ]) as any
    )
    try {
      const scanProvider = createMockProvider()
      vi.mocked(scanProvider.summarize).mockResolvedValue({
        decisions: [],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      })
      ;(scanProvider as { completePrompt?: unknown }).completePrompt = vi.fn().mockResolvedValue('')
      const scanService = new SegmentationService(
        scanProvider,
        {
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
          getNotesAccelerator: () => 'cpu'
        } as unknown as OllamaManager,
        '/mock/home/AutoDoc/recordings'
      )
      await (scanService as any).processJob('m1')
      expect(capturedPolicies[0]).toEqual({
        maxAttemptsPerSection: 1,
        bailAfterConsecutiveRejects: 0,
        skipRewrites: true,
        skipStructureLlm: true
      })
      expect(capturedPresentationModes[0]).toBe('lossless')
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      if (previousTight == null) delete process.env.AUTODOC_TEST_NOTES_TIGHT
      else process.env.AUTODOC_TEST_NOTES_TIGHT = previousTight
      if (previousPolicy == null) delete process.env.AUTODOC_TEST_NOTES_SCAN_POLICY
      else process.env.AUTODOC_TEST_NOTES_SCAN_POLICY = previousPolicy
      pipeline.mockRestore()
      promote.mockRestore()
    }
  })

  it('logs onComplete callback failures without failing completed segmentation', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000,
          confidence: 0.9
        }
      ]) as any
    )
    vi.mocked(provider.summarize).mockResolvedValue({
      decisions: [],
      actionItems: [],
      information: [
        {
          id: 'seg-1',
          meetingId: 'm1',
          category: 'information',
          topic: 'Rollout',
          title: 'Plan confirmed',
          content: 'The rollout plan was confirmed.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 65_000
        }
      ],
      discussion: [],
      statusUpdates: []
    })
    const error = new Error('callback failed')
    service.onComplete(() => {
      throw error
    })

    const serviceTestApi = service as unknown as {
      processJob(meetingId: string): Promise<void>
    }

    await expect(serviceTestApi.processJob('m1')).resolves.toBeUndefined()

    expect(mocks.logAutodocFailure).toHaveBeenCalledWith({
      area: 'segmentation',
      message: 'Segmentation completion callback failed',
      error,
      meetingId: 'm1'
    })
  })

  it('does not invoke onComplete when segmentation fails', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000,
          confidence: 0.9
        }
      ]) as any
    )
    vi.mocked(provider.summarize).mockRejectedValue(new Error('Ollama unavailable'))
    const onComplete = vi.fn()
    service.onComplete(onComplete)

    await expect((service as any).processJob('m1')).rejects.toThrow('Ollama unavailable')
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('marks substantive empty segmentation output as transcript-only instead of retry-failed', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm2-0',
          meetingId: 'm2',
          speaker: 'Chris',
          text: 'We reviewed the onboarding funnel metrics and conversion dropped from 42 percent to 31 percent after the pricing page update went live on Monday.',
          startMs: 0,
          endMs: 30_000,
          confidence: 0.8
        },
        {
          id: 'm2-1',
          meetingId: 'm2',
          speaker: 'Pat',
          text: 'The team agreed we need an experiment plan, a rollback option, and a written owner list for engineering, design, and growth before next Tuesday.',
          startMs: 45_000,
          endMs: 85_000,
          confidence: 0.8
        },
        {
          id: 'm2-2',
          meetingId: 'm2',
          speaker: 'Chris',
          text: 'Finance also confirmed the current acquisition budget is capped at fifty thousand dollars for the quarter, so any campaign changes need approval this week.',
          startMs: 95_000,
          endMs: 130_000,
          confidence: 0.8
        },
        {
          id: 'm2-3',
          meetingId: 'm2',
          speaker: 'Pat',
          text: 'We also discussed support volume, launch timing, customer messaging, and the dependency on the billing migration that is still in progress.',
          startMs: 135_000,
          endMs: 170_000,
          confidence: 0.8
        }
      ]) as any
    )

    vi.mocked(provider.getLastWriterSkips!).mockReturnValue([
      { chunkIndex: 1, attempts: 2, rawHead: '{"decisions"', rawTail: 'na ' }
    ])

    await expect((service as any).processJob('m2')).resolves.toBeUndefined()

    expect(cryptoMock.encryptJSON).not.toHaveBeenCalled()
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      join('/mock/home/AutoDoc/recordings', 'm2', 'segments.error'),
      JSON.stringify({
        error:
          'LLM returned empty segments for non-trivial transcript — likely context overflow or model issue',
        retries: 0,
        status: 'no-notes',
        errorCode: 'no_notes_detected',
        userReason:
          'No notes were generated. There wasn’t enough conversation to turn into notes. Your transcript is still available.'
      })
    )
  })

  it('waits for shared Ollama setup instead of failing notes while setup is still running', async () => {
    const setup = deferred()
    const waitingOllama = {
      waitUntilReady: vi.fn(() => setup.promise)
    } as unknown as OllamaManager
    provider = createMockProvider()
    ;(provider.summarize as ReturnType<typeof vi.fn>).mockResolvedValue({
      decisions: [
        {
          topic: 'Planning',
          title: 'Follow-up planned',
          content: 'The team agreed to follow up next week.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 15_000
        }
      ],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    })
    service = new SegmentationService(provider, waitingOllama, '/mock/home/AutoDoc/recordings')
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm3-0',
          meetingId: 'm3',
          speaker: 'Chris',
          text: 'We should follow up next week.',
          startMs: 0,
          endMs: 15_000,
          confidence: 0.8
        }
      ]) as any
    )

    const processing = (service as any).processJob('m3')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(waitingOllama.waitUntilReady).toHaveBeenCalledOnce()
    expect(provider.summarize).not.toHaveBeenCalled()
    expect(fsMock.writeFile).not.toHaveBeenCalled()

    setup.resolve()
    await expect(processing).resolves.toBeUndefined()

    expect(provider.summarize).toHaveBeenCalledOnce()
    expect(cryptoMock.encryptJSON).toHaveBeenCalledWith(
      {
        decisions: [
          {
            topic: 'Planning',
            title: 'Follow-up planned',
            content: 'The team agreed to follow up next week.',
            assignee: null,
            deadline: null,
            sourceStartMs: 0,
            sourceEndMs: 15_000
          }
        ],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      },
      join('/mock/home/AutoDoc/recordings', 'm3', 'segments.json')
    )
  })

  it('prioritizes direct jobs ahead of recovery-scan jobs', () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)

    service.enqueue('recovery-1', 'recovery-scan')
    service.enqueue('direct-1', 'direct')

    expect((service as any).queue).toEqual(['direct-1', 'recovery-1'])
  })

  it('preempts an active recovery-scan job when a direct job arrives', () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)
    ;(service as any).activeJobId = 'recovery-active'
    ;(service as any).activeJobSource = 'recovery-scan'
    ;(service as any).processing = true

    service.enqueue('direct-1', 'direct')

    expect(provider.abortActiveRequests as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'SEGMENTATION_PREEMPTED'
    )
    expect((service as any).queue).toEqual(['direct-1', 'recovery-active'])
  })

  it('enables low-memory LLM mode for low-spec Mac profiles', async () => {
    provider = createMockProvider()
    ;(provider.summarize as ReturnType<typeof vi.fn>).mockResolvedValue({
      decisions: [
        {
          topic: 'Planning',
          title: 'Follow-up planned',
          content: 'The team agreed to follow up next week.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 15_000
        }
      ],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    })
    service = new SegmentationService(
      provider,
      createMockOllamaManager(),
      '/mock/home/AutoDoc/recordings',
      null,
      () => ({
        id: 'mac-low-spec',
        label: 'Low-spec Apple Silicon Mac',
        reason: 'totalMemoryGiB <= 8.5',
        hardware: {
          platform: 'darwin',
          arch: 'arm64',
          isAppleSilicon: true,
          chip: 'Apple M1',
          logicalProcessors: 8,
          totalMemoryGiB: 8,
          freeMemoryGiB: 2.5,
          memoryPressure: 'green',
          swapUsedGiB: 0
        },
        transcriptionBackend: 'mlx-whisper',
        transcriptionModel: 'distil-large-v3',
        notesModel: LOW_SPEC_MAC_OLLAMA_MODEL,
        dualSourceMode: 'sequential',
        notesAfterTranscriptionOnly: true,
        serializeLocalProcessing: true
      })
    )
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm-low-0',
          meetingId: 'm-low',
          speaker: 'Chris',
          text: 'We should follow up next week.',
          startMs: 0,
          endMs: 15_000,
          confidence: 0.8
        }
      ]) as any
    )

    await (service as any).processJob('m-low')

    expect(provider.setLowMemoryMode).toHaveBeenCalledWith(true)
    expect(provider.setModel).toHaveBeenCalledWith(LOW_SPEC_MAC_OLLAMA_MODEL)
    expect(provider.summarize).toHaveBeenCalledOnce()
  })

  it('enables Qwen notes on capable Windows profiles without low-memory mode', async () => {
    service = new SegmentationService(
      provider,
      createMockOllamaManager(),
      '/mock/home/AutoDoc/recordings',
      null,
      null,
      null,
      () => ({
        id: 'win-gpu',
        label: 'GPU Windows processing',
        reason: 'test',
        hardware: { logicalProcessors: 16, totalMemoryGiB: 32, freeMemoryGiB: 12 },
        notesModel: DEFAULT_OLLAMA_MODEL,
        dualSourceMode: 'concurrent',
        serializeLocalProcessing: false,
        notesAfterTranscriptionOnly: false,
        threadPolicy: 'default'
      })
    )
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm-win-0',
          meetingId: 'm-win',
          speaker: 'Chris',
          text: 'We should follow up next week.',
          startMs: 0,
          endMs: 15_000,
          confidence: 0.8
        }
      ]) as any
    )

    await (service as any).processJob('m-win')

    expect(provider.setModel).toHaveBeenCalledWith(DEFAULT_OLLAMA_MODEL)
    expect(provider.setLowMemoryMode).toHaveBeenCalledWith(false)
  })

  it('reaps leftover Ollama runners before selecting the notes processing profile', async () => {
    const order: string[] = []
    const reapLeftoverRunners = vi.fn((reason?: string) => {
      if (reason === 'before-notes-profile') order.push('reap')
    })
    const getEffectiveMacProcessingProfile = vi.fn(async () => {
      order.push('snapshot')
      return null
    })
    service = new SegmentationService(
      provider,
      { waitUntilReady: vi.fn().mockResolvedValue(undefined), reapLeftoverRunners },
      '/mock/home/AutoDoc/recordings',
      null,
      null,
      getEffectiveMacProcessingProfile
    )
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm-reap-0',
          meetingId: 'm-reap',
          speaker: 'Chris',
          text: 'We should follow up next week.',
          startMs: 0,
          endMs: 15_000,
          confidence: 0.8
        }
      ]) as any
    )
    vi.mocked(provider.summarize).mockResolvedValue({
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    })

    await (service as any).processJob('m-reap')

    expect(reapLeftoverRunners).toHaveBeenCalledWith('before-notes-profile', 'm-reap')
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(reapLeftoverRunners).toHaveBeenCalledWith('after-notes', 'm-reap')
    } else {
      expect(reapLeftoverRunners).not.toHaveBeenCalledWith('after-notes', 'm-reap')
    }
    expect(reapLeftoverRunners).not.toHaveBeenCalledWith('before-scan', 'm-reap')
    expect(getEffectiveMacProcessingProfile).toHaveBeenCalled()
    expect(order).toEqual(['reap', 'snapshot'])
  })

  it('reaps the writer runner before scan and again after notes finish', async () => {
    const order: string[] = []
    const reapLeftoverRunners = vi.fn((reason?: string) => {
      order.push(`reap:${reason}`)
    })
    const recycleBloatedRunners = vi.fn(async (reason?: string) => {
      order.push(`recycle:${reason}`)
      return false
    })
    provider = createMockProvider()
    provider.completePrompt = vi.fn().mockResolvedValue('')
    vi.mocked(provider.summarize).mockImplementation(async () => {
      order.push('writer')
      return {
        decisions: [],
        actionItems: [],
        information: [
          {
            id: 'seg-1',
            meetingId: 'm-scan-reap',
            category: 'information',
            topic: 'Rollout',
            title: 'Plan confirmed',
            content: 'The rollout plan was confirmed.',
            assignee: null,
            deadline: null,
            sourceStartMs: 0,
            sourceEndMs: 65_000
          }
        ],
        discussion: [],
        statusUpdates: []
      }
    })
    vi.mocked(provider.releaseResources!).mockImplementation(async () => {
      order.push('unload')
    })
    const pipeline = vi
      .spyOn(notesScanPipeline, 'runNotesScanPipeline')
      .mockImplementation(async (_segments, options) => {
        order.push('scan')
        await options.generate({
          prompt: 'scan',
          num_ctx: 8192,
          num_predict: 64,
          temperature: 0,
          seed: 1,
          stop: []
        })
        return {
          markdown: '',
          content: {
            overview: null,
            keyTakeaways: [],
            sections: [],
            decisions: [],
            nextSteps: []
          },
          groupingFallback: false,
          restyleFallbacks: 0,
          compressFallbacks: 0,
          restyleSkips: 0,
          compressSkips: 0,
          restyleRejectReasons: [],
          compressRejectReasons: [],
          attachFailed: false,
          overviewFailed: false,
          overviewFailureReasons: [],
          validation: {
            ran: false,
            error: null,
            ledgerChunksFailed: 0,
            claimsChecked: 0,
            claimsDropped: 0,
            ownersStripped: 0,
            ledgerAppends: 0,
            unvalidatedClaims: 0
          }
        }
      })
    const promote = vi
      .spyOn(NotesRepository.prototype, 'promoteLegacyToV2')
      .mockResolvedValue({} as never)
    service = new SegmentationService(
      provider,
      {
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        reapLeftoverRunners,
        recycleBloatedRunners
      },
      '/mock/home/AutoDoc/recordings'
    )
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm-scan-reap-0',
          meetingId: 'm-scan-reap',
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000,
          confidence: 0.9
        }
      ]) as never
    )

    await (service as any).processJob('m-scan-reap')

    expect(order).toEqual([
      'reap:before-notes-profile',
      'writer',
      process.platform === 'win32' ? 'recycle:before-scan' : 'reap:before-scan',
      'scan',
      ...(process.platform === 'darwin' || process.platform === 'win32'
        ? ['unload', 'reap:after-notes']
        : [])
    ])
    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'notes scan first ollama request',
        meetingId: 'm-scan-reap',
        context: expect.objectContaining({ num_ctx: 8192 })
      })
    )
    pipeline.mockRestore()
    promote.mockRestore()
  })

  it('keeps notes progress monotonic across retries', () => {
    const send = vi.fn()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ webContents: { send } }] as any)
    ;(service as any).broadcastStatus('meeting-123', 'segmenting', 44)
    ;(service as any).broadcastStatus('meeting-123', 'segmenting', 33)
    ;(service as any).broadcastStatus('meeting-123', 'segmenting', 45)

    expect(send).toHaveBeenNthCalledWith(1, 'segmentation:status-changed', {
      meetingId: 'meeting-123',
      status: 'segmenting',
      progress: 44,
      errorCode: undefined
    })
    expect(send).toHaveBeenNthCalledWith(2, 'segmentation:status-changed', {
      meetingId: 'meeting-123',
      status: 'segmenting',
      progress: 44,
      errorCode: undefined
    })
    expect(send).toHaveBeenNthCalledWith(3, 'segmentation:status-changed', {
      meetingId: 'meeting-123',
      status: 'segmenting',
      progress: 45,
      errorCode: undefined
    })
  })

  it('replaces an unhealthy Ollama runtime once before deferring notes', async () => {
    const recoverUnhealthyRuntime = vi.fn().mockResolvedValue(undefined)
    const notReadyThenReady = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      isReadyForGeneration: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      recoverUnhealthyRuntime
    }
    provider = createMockProvider()
    service = new SegmentationService(provider, notReadyThenReady, '/mock/home/AutoDoc/recordings')

    await expect((service as any).ensureOllamaReadyForGeneration('m-recover')).resolves.toBe(true)
    expect(recoverUnhealthyRuntime).toHaveBeenCalledOnce()
    expect(notReadyThenReady.isReadyForGeneration).toHaveBeenCalledTimes(2)
  })

  it('defers notes generation when Ollama is not ready without consuming recovery retries', async () => {
    vi.useFakeTimers()
    const notReadyOllama = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      isReadyForGeneration: vi.fn().mockResolvedValue(false)
    }
    provider = createMockProvider()
    service = new SegmentationService(provider, notReadyOllama, '/mock/home/AutoDoc/recordings')
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm-ollama-0',
          meetingId: 'm-ollama',
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000,
          confidence: 0.9
        }
      ]) as any
    )

    const enqueueSpy = vi.spyOn(service, 'enqueue')

    const processing = (service as any).processJobExclusive('m-ollama')
    await vi.advanceTimersByTimeAsync(0)
    await processing
    await vi.advanceTimersByTimeAsync(1_000)

    expect(notReadyOllama.waitUntilReady).toHaveBeenCalled()
    expect(notReadyOllama.isReadyForGeneration).toHaveBeenCalled()
    expect(provider.summarize).not.toHaveBeenCalled()
    expect(fsMock.writeFile).not.toHaveBeenCalled()
    expect(enqueueSpy).toHaveBeenCalledWith('m-ollama', 'direct')
    vi.useRealTimers()
  })

  it('starts a fresh Ollama defer cycle on retry after defer budget is exhausted', async () => {
    vi.useFakeTimers()
    try {
      const notReadyOllama = {
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        isReadyForGeneration: vi.fn().mockResolvedValue(false)
      }
      provider = createMockProvider()
      service = new SegmentationService(provider, notReadyOllama, '/mock/home/AutoDoc/recordings')
      fsMock.access.mockImplementation(async (path) => {
        if (String(path).endsWith('transcript.json')) return undefined
        throw new Error('ENOENT')
      })
      fsMock.readFile.mockResolvedValue(
        JSON.stringify([
          {
            id: 'm-poison-0',
            meetingId: 'm-poison',
            speaker: 'Chris',
            text: 'We confirmed the rollout plan.',
            startMs: 0,
            endMs: 65_000,
            confidence: 0.9
          }
        ]) as any
      )
      fsMock.writeFile.mockResolvedValue(undefined as any)

      for (let i = 0; i < 5; i++) {
        await (service as any).processJobExclusive('m-poison')
      }
      await expect((service as any).processJobExclusive('m-poison')).rejects.toThrow(
        'Ollama unavailable for notes generation — model runtime never became ready'
      )
      await (service as any).markFailed(
        'm-poison',
        new Error('Ollama unavailable for notes generation — model runtime never became ready')
      )

      vi.clearAllTimers()
      const failureWrites = fsMock.writeFile.mock.calls.length
      const enqueueSpy = vi.spyOn(service, 'enqueue')

      service.retry('m-poison')
      await vi.advanceTimersByTimeAsync(0)

      expect(fsMock.writeFile).toHaveBeenCalledTimes(failureWrites)
      expect(provider.summarize).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1_000)
      expect(enqueueSpy).toHaveBeenCalledWith('m-poison', 'direct')
      expect(fsMock.writeFile).toHaveBeenCalledTimes(failureWrites)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-enqueue a meeting that is mid Ollama defer cycle during pending scan', async () => {
    vi.useFakeTimers()
    try {
      const notReadyOllama = {
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        isReadyForGeneration: vi.fn().mockResolvedValue(false)
      }
      provider = createMockProvider()
      service = new SegmentationService(provider, notReadyOllama, '/mock/home/AutoDoc/recordings')
      fsMock.access.mockImplementation(async (path) => {
        if (String(path).endsWith('transcript.json')) return undefined
        throw new Error('ENOENT')
      })
      fsMock.readFile.mockResolvedValue(
        JSON.stringify([
          {
            id: 'm-scan-0',
            meetingId: 'm-scan',
            speaker: 'Chris',
            text: 'We confirmed the rollout plan.',
            startMs: 0,
            endMs: 65_000,
            confidence: 0.9
          }
        ]) as any
      )

      await (service as any).processJobExclusive('m-scan')
      expect((service as any).ollamaGenerationDeferCounts.get('m-scan')).toBe(1)

      fsMock.readdir.mockResolvedValue(['m-scan'] as any)
      fsMock.stat.mockResolvedValue({ isDirectory: () => true } as any)

      const enqueueSpy = vi.spyOn(service, 'enqueue')
      await service.scanAndEnqueuePending()

      expect(enqueueSpy).not.toHaveBeenCalled()
      expect((service as any).ollamaGenerationDeferCounts.get('m-scan')).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears activeProgress after a job finishes', () => {
    const send = vi.fn()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ webContents: { send } }] as any)
    ;(service as any).activeProgress = 99
    ;(service as any).activeJobId = null
    ;(service as any).activeStatus = null
    ;(service as any).activeProgress = undefined
    ;(service as any).broadcastStatus('meeting-new', 'segmenting', 10)

    expect(send).toHaveBeenCalledWith('segmentation:status-changed', {
      meetingId: 'meeting-new',
      status: 'segmenting',
      progress: 10,
      errorCode: undefined
    })
  })

  it('exposes and broadcasts activity only for the active segmenting meeting', () => {
    const send = vi.fn()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ webContents: { send } }] as any)
    ;(service as any).activeJobId = 'meeting-a'
    ;(service as any).activeStatus = 'segmenting'
    ;(service as any).updateActivity('meeting-a', 'waiting-for-local-ai')

    expect(service.getActivity('meeting-a')).toBe('waiting-for-local-ai')
    expect(service.getActivity('meeting-b')).toBeNull()
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('segmentation:activity-changed', {
      meetingId: 'meeting-a',
      activity: 'waiting-for-local-ai'
    })
    ;(service as any).updateActivity('meeting-b', 'waiting-for-local-ai')
    ;(service as any).updateActivity('meeting-a', 'waiting-for-local-ai')

    expect(send).toHaveBeenCalledOnce()
    ;(service as any).activeStatus = 'complete'
    expect(service.getActivity('meeting-a')).toBeNull()
  })

  it('clears activity at job cleanup and ignores callbacks from that job after the next starts', async () => {
    const send = vi.fn()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ webContents: { send } }] as any)
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) {
        return JSON.stringify([
          {
            id: 'meeting-a-0',
            meetingId: 'meeting-a',
            speaker: 'Chris',
            text: 'We confirmed the rollout plan and assigned the remaining launch tasks.',
            startMs: 0,
            endMs: 65_000,
            confidence: 0.9
          }
        ]) as any
      }
      throw new Error('ENOENT')
    })

    let reportActivity: ((activity: 'waiting-for-local-ai' | null) => void) | undefined
    vi.mocked(provider.summarize).mockImplementation(async (...args: any[]) => {
      reportActivity = args[4]
      reportActivity?.('waiting-for-local-ai')
      return {
        decisions: [],
        actionItems: [],
        information: [
          {
            id: 'segment-1',
            meetingId: 'meeting-a',
            category: 'information',
            topic: 'Rollout',
            title: 'Plan confirmed',
            content: 'The rollout plan was confirmed.',
            assignee: null,
            deadline: null,
            sourceStartMs: 0,
            sourceEndMs: 65_000
          }
        ],
        discussion: [],
        statusUpdates: []
      }
    })
    ;(service as any).queue = ['meeting-a']

    await (service as any).processNext()

    expect(reportActivity).toBeTypeOf('function')
    expect(send).toHaveBeenCalledWith('segmentation:activity-changed', {
      meetingId: 'meeting-a',
      activity: 'waiting-for-local-ai'
    })
    expect(send).toHaveBeenCalledWith('segmentation:activity-changed', {
      meetingId: 'meeting-a',
      activity: null
    })
    expect(service.getActivity('meeting-a')).toBeNull()

    const activityEventCount = send.mock.calls.filter(
      ([channel]) => channel === 'segmentation:activity-changed'
    ).length
    ;(service as any).activeJobId = 'meeting-b'
    ;(service as any).activeStatus = 'segmenting'
    reportActivity?.('waiting-for-local-ai')

    expect(service.getActivity('meeting-a')).toBeNull()
    expect(service.getActivity('meeting-b')).toBeNull()
    expect(
      send.mock.calls.filter(([channel]) => channel === 'segmentation:activity-changed')
    ).toHaveLength(activityEventCount)
  })

  it('does not let activity delivery failures interrupt notes processing', () => {
    const send = vi.fn(() => {
      throw new Error('window closed')
    })
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ webContents: { send } }] as any)
    ;(service as any).activeJobId = 'meeting-a'
    ;(service as any).activeStatus = 'segmenting'

    expect(() => (service as any).updateActivity('meeting-a', 'waiting-for-local-ai')).not.toThrow()
    expect(service.getActivity('meeting-a')).toBe('waiting-for-local-ai')
  })

  describe('LLM resource release', () => {
    const originalPlatform = process.platform

    const setPlatform = (platform: NodeJS.Platform) => {
      Object.defineProperty(process, 'platform', {
        value: platform,
        configurable: true
      })
    }

    beforeEach(() => {
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
    })

    function setupSummarizeTranscript() {
      fsMock.access.mockImplementation(async (path) => {
        if (String(path).endsWith('transcript.json')) return undefined
        throw new Error('ENOENT')
      })
      fsMock.readFile.mockResolvedValue(
        JSON.stringify([
          {
            id: 'm1-0',
            meetingId: 'm1',
            speaker: 'Chris',
            text: 'We confirmed the rollout plan.',
            startMs: 0,
            endMs: 65_000,
            confidence: 0.9
          }
        ]) as any
      )
      vi.mocked(provider.summarize).mockResolvedValue({
        decisions: [],
        actionItems: [],
        information: [
          {
            id: 'seg-1',
            meetingId: 'm1',
            category: 'information',
            topic: 'Rollout',
            title: 'Plan confirmed',
            content: 'The rollout plan was confirmed.',
            assignee: null,
            deadline: null,
            sourceStartMs: 0,
            sourceEndMs: 65_000
          }
        ],
        discussion: [],
        statusUpdates: []
      })
    }

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true
      })
    })

    it('calls releaseResources after successful summarize on win32', async () => {
      setPlatform('win32')
      provider = createMockProvider()
      service = new SegmentationService(
        provider,
        createMockOllamaManager(),
        '/mock/home/AutoDoc/recordings'
      )
      setupSummarizeTranscript()

      await (service as any).processJob('m1')

      expect(provider.releaseResources).toHaveBeenCalledWith('m1')
    })

    it('calls releaseResources on win32 when summarize throws', async () => {
      setPlatform('win32')
      provider = createMockProvider()
      service = new SegmentationService(
        provider,
        createMockOllamaManager(),
        '/mock/home/AutoDoc/recordings'
      )
      setupSummarizeTranscript()
      vi.mocked(provider.summarize).mockRejectedValue(new Error('Ollama unavailable'))

      await expect((service as any).processJob('m1')).rejects.toThrow('Ollama unavailable')
      expect(provider.releaseResources).toHaveBeenCalledWith('m1')
    })

    it('logs a windows resource snapshot after summarize', async () => {
      setPlatform('win32')
      provider = createMockProvider()
      service = new SegmentationService(
        provider,
        createMockOllamaManager(),
        '/mock/home/AutoDoc/recordings'
      )
      setupSummarizeTranscript()
      const logNotesResourceSnapshot = vi
        .spyOn(service as any, 'logNotesResourceSnapshot')
        .mockResolvedValue(undefined)

      await (service as any).processJob('m1')

      expect(logNotesResourceSnapshot).toHaveBeenCalledWith('notes resources released', 'm1')
    })

    it('calls releaseResources after successful summarize on darwin', async () => {
      setPlatform('darwin')
      provider = createMockProvider()
      service = new SegmentationService(
        provider,
        createMockOllamaManager(),
        '/mock/home/AutoDoc/recordings'
      )
      setupSummarizeTranscript()

      await (service as any).processJob('m1')

      expect(provider.releaseResources).toHaveBeenCalledWith('m1')
    })
  })
})
