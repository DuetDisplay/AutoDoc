import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WhisperManager } from '../whisper-manager'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
  },
}))

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  chmod: vi.fn(),
}))

const mockAccess = vi.mocked(await import('fs/promises')).access

describe('WhisperManager', () => {
  let manager: WhisperManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new WhisperManager()
  })

  it('returns correct models directory path', () => {
    expect(manager.getModelsDir()).toBe('/mock/home/models')
  })

  it('returns correct whisper binary path', () => {
    expect(manager.getWhisperPath()).toBe('/mock/home/models/whisper-cpp')
  })

  it('returns correct ffmpeg binary path', () => {
    expect(manager.getFfmpegPath()).toBe('/mock/home/models/ffmpeg')
  })

  it('returns correct model path', () => {
    expect(manager.getModelPath()).toBe('/mock/home/models/ggml-large-v3.bin')
  })

  it('reports ready when all files exist', async () => {
    mockAccess.mockResolvedValue(undefined)
    const ready = await manager.isReady()
    expect(ready).toBe(true)
    expect(mockAccess).toHaveBeenCalledTimes(3)
  })

  it('reports not ready when whisper binary is missing', async () => {
    mockAccess
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(undefined)
    const ready = await manager.isReady()
    expect(ready).toBe(false)
  })

  it('reports not ready when model is missing', async () => {
    mockAccess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(undefined)
    const ready = await manager.isReady()
    expect(ready).toBe(false)
  })
})
