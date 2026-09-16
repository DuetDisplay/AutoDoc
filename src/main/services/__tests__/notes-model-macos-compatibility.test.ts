import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalPlatform = vi.hoisted(() => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  return original
})

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn()
}))
vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptJSON: vi.fn(),
  encryptJSON: vi.fn()
}))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))

import { OllamaManager } from '../ollama-manager'
import { SegmentationService } from '../segmentation'
import type { LLMProvider } from '../llm'
import { selectMacProcessingProfile } from '../mac-processing-profile'
import * as scan from '../notes-scan-pipeline'
import {
  DEFAULT_OLLAMA_MODEL as QWEN,
  LOW_SPEC_MAC_OLLAMA_MODEL as SMALL,
  LEGACY_OLLAMA_MODEL as LEGACY
} from '../../../shared/constants'
const fs = vi.mocked(await import('fs/promises'))
const missing = new Error("Ollama returned 404: model 'qwen3:4b-instruct' not found")

beforeEach(() => {
  vi.clearAllMocks()
  fs.access.mockResolvedValue(undefined)
  fs.unlink.mockResolvedValue(undefined)
  fs.writeFile.mockResolvedValue(undefined)
  fs.lstat.mockRejectedValue({ code: 'ENOENT' })
  fs.readFile.mockResolvedValue(
    JSON.stringify([
      {
        id: 'row',
        meetingId: 'mac',
        speaker: 'me',
        text: 'We agreed to launch the customer portal on Friday.',
        startMs: 0,
        endMs: 5000,
        confidence: 1
      }
    ])
  )
})
afterEach(() => vi.restoreAllMocks())
afterAll(() =>
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
)

function managerFixture(models: string[], preferred = QWEN) {
  const installed = new Set(models)
  const manager = new OllamaManager(preferred)
  vi.spyOn(manager, 'start').mockResolvedValue(undefined)
  vi.spyOn(manager, 'listInstalledModels').mockImplementation(async () => [...installed])
  const pull = vi.spyOn(manager, 'pullModel').mockImplementation(async (model) => {
    installed.add(model!)
  })
  const remove = vi.spyOn(manager, 'deleteModel').mockImplementation(async (model) => {
    installed.delete(model)
  })
  return { manager, installed, pull, remove }
}

function jobFixture() {
  let model = QWEN
  const provider: LLMProvider = {
    summarize: vi
      .fn()
      .mockResolvedValue({
        decisions: [],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      }),
    checkConnection: vi.fn().mockResolvedValue(true),
    getModel: () => model,
    setModel: vi.fn((value) => {
      model = value
    }),
    setLowMemoryMode: vi.fn(),
    releaseResources: vi.fn().mockResolvedValue(undefined)
  }
  const readiness = {
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    isReadyForGeneration: vi.fn().mockResolvedValue(true),
    prepareModelForGeneration: vi.fn().mockResolvedValue(LEGACY),
    beginNotesGeneration: vi.fn(),
    endNotesGeneration: vi.fn().mockResolvedValue(undefined)
  }
  const profile = selectMacProcessingProfile({
    platform: 'darwin',
    arch: 'arm64',
    isAppleSilicon: true,
    chip: 'Apple M1',
    logicalProcessors: 8,
    totalMemoryGiB: 8,
    freeMemoryGiB: 4,
    memoryPressure: 'green',
    swapUsedGiB: 0
  })
  const service = new SegmentationService(provider, readiness, '/recordings', null, () => profile)
  return { provider, readiness, service }
}

describe('macOS retains the pre-fix notes behavior', () => {
  it('keeps cached startup readiness without entering per-job model preparation', async () => {
    const { manager, installed, pull, remove } = managerFixture([QWEN, SMALL])
    const prepare = vi.spyOn(manager, 'ensureNotesModelReady')
    await manager.startAndPull()
    expect(prepare).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith(SMALL)
    installed.delete(QWEN)
    await manager.waitUntilReady()
    expect(pull).not.toHaveBeenCalled()
  })

  it('keeps the existing background legacy migration and immediate cleanup', async () => {
    const { manager, installed, pull, remove } = managerFixture([LEGACY, SMALL])
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    pull.mockImplementation(async (model) => {
      await pending
      installed.add(model!)
    })
    manager.beginNotesGeneration()
    await manager.startAndPull()
    expect(manager.getModel()).toBe(LEGACY)
    finish()
    await vi.waitFor(() => expect(manager.getModel()).toBe(QWEN))
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(LEGACY))
    expect(remove).toHaveBeenCalledWith(SMALL)
  })

  it('keeps the existing low-spec Mac model and migration path', async () => {
    const { manager, pull, remove } = managerFixture([LEGACY], SMALL)
    const prepare = vi.spyOn(manager, 'ensureNotesModelReady')
    await manager.startAndPull()
    expect(manager.getModel()).toBe(SMALL)
    expect(pull).toHaveBeenCalledWith(SMALL, expect.any(Number))
    // The original pull-before-ready plan has no leftovers until the next setup.
    expect(remove).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    manager.resetReady()
    await manager.startAndPull()
    expect(remove).toHaveBeenCalledWith(LEGACY)
  })

  it('keeps the Mac profile model and original readiness checks without Windows hooks', async () => {
    const { service, provider, readiness } = jobFixture()
    vi.spyOn(service as any, 'persistScanLayerNotes').mockResolvedValue({ notesLayout: 'v2' })
    await (service as any).processJob('mac')
    expect(provider.getModel!()).toBe(SMALL)
    expect(provider.setLowMemoryMode).toHaveBeenCalledWith(true)
    expect(readiness.isReadyForGeneration).toHaveBeenCalledWith()
    expect(readiness.prepareModelForGeneration).not.toHaveBeenCalled()
    expect(readiness.beginNotesGeneration).not.toHaveBeenCalled()
    expect(readiness.endNotesGeneration).not.toHaveBeenCalled()
    expect(provider.summarize).toHaveBeenCalledOnce()
    expect(provider.releaseResources).toHaveBeenCalledOnce()
  })

  it('does not introduce whole-job missing-model retries on Mac', async () => {
    const { service, provider, readiness } = jobFixture()
    vi.mocked(provider.summarize).mockRejectedValue(missing)
    await expect((service as any).processJob('mac')).rejects.toBe(missing)
    expect(provider.summarize).toHaveBeenCalledOnce()
    expect(readiness.prepareModelForGeneration).not.toHaveBeenCalled()
  })

  it('preserves Mac setup errors instead of converting them to the Windows setup category', async () => {
    const { service, readiness } = jobFixture()
    const offline = new Error('offline')
    readiness.waitUntilReady.mockRejectedValue(offline)
    await expect((service as any).ensureOllamaReadyForGeneration('mac', QWEN)).rejects.toBe(offline)
  })

  it('keeps the existing Mac scan fallback on a missing-model error', async () => {
    const { service, provider } = jobFixture()
    provider.completePrompt = vi.fn()
    vi.spyOn(scan, 'runNotesScanPipeline').mockRejectedValue(missing)
    const segments = {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }
    await expect(
      (service as any).persistScanLayerNotes('mac', segments, [])
    ).resolves.toMatchObject({ notesLayout: 'v1', errorCode: 'scan_or_persist' })
  })

  it('does not apply the new Windows recovery-scan suppression on Mac', async () => {
    const { service } = jobFixture()
    fs.readdir.mockResolvedValue(['mac'] as any)
    fs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    fs.access.mockImplementation(async (path) => {
      if (String(path).endsWith('segments.json')) throw new Error('ENOENT')
    })
    fs.readFile.mockResolvedValue(
      JSON.stringify({
        error: 'Ollama notes model setup failed: offline',
        errorCode: 'ollama-model-setup',
        retries: 1,
        status: 'failed'
      })
    )
    const enqueue = vi.spyOn(service, 'enqueue').mockImplementation(() => {})
    await service.scanAndEnqueuePending()
    expect(enqueue).toHaveBeenCalledWith('mac', 'recovery-scan')
  })
})
