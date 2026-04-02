import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SegmentationService } from '../segmentation'
import type { LLMProvider } from '../llm'
import type { OllamaManager } from '../ollama-manager'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptJSON: vi.fn(),
  encryptJSON: vi.fn(),
}))

const fsMock = vi.mocked(await import('fs/promises'))

function createMockProvider(): LLMProvider {
  return {
    summarize: vi.fn().mockResolvedValue({
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: [],
    }),
    checkConnection: vi.fn().mockResolvedValue(true),
  }
}

function createMockOllamaManager(): OllamaManager {
  return {
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as OllamaManager
}

describe('SegmentationService', () => {
  let service: SegmentationService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new SegmentationService(
      createMockProvider(),
      createMockOllamaManager(),
      '/mock/home/AutoDoc/recordings',
    )
  })

  it('returns pending status when no files exist', async () => {
    fsMock.access.mockRejectedValue(new Error('ENOENT'))

    const status = await service.getStatus('meeting-123')
    expect(status).toBe('pending')
  })

  it('returns failed status when segments.error is newer than segments.json', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('segments.json') || String(path).endsWith('segments.error')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.stat.mockImplementation(async (path) => ({
      isDirectory: () => false,
      mtimeMs: String(path).endsWith('segments.error') ? 200 : 100,
    }) as any)

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

    await expect((service as any).markFailed('deleted-meeting', 'This operation was aborted')).resolves.toBeUndefined()
  })
})
