import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AudioConverter } from '../audio-converter'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

const mockSpawn = vi.mocked(await import('child_process')).spawn

function createMockProcess(exitCode: number, stderr = '') {
  const proc = {
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(exitCode), 0)
      }
      return proc
    }),
    stderr: {
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'data' && stderr) {
          setTimeout(() => cb(Buffer.from(stderr)), 0)
        }
        return proc.stderr
      }),
    },
  }
  return proc
}

describe('AudioConverter', () => {
  let converter: AudioConverter

  beforeEach(() => {
    vi.clearAllMocks()
    converter = new AudioConverter()
  })

  it('spawns ffmpeg with correct arguments', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0) as any)

    await converter.convert('/input/audio.webm', '/output/audio.wav', '/bin/ffmpeg')

    expect(mockSpawn).toHaveBeenCalledWith(
      '/bin/ffmpeg',
      ['-i', '/input/audio.webm', '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', '/output/audio.wav'],
    )
  })

  it('resolves on exit code 0', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0) as any)

    await expect(
      converter.convert('/input/audio.webm', '/output/audio.wav', '/bin/ffmpeg')
    ).resolves.toBeUndefined()
  })

  it('rejects on non-zero exit code', async () => {
    mockSpawn.mockReturnValue(createMockProcess(1, 'Invalid input') as any)

    await expect(
      converter.convert('/input/audio.webm', '/output/audio.wav', '/bin/ffmpeg')
    ).rejects.toThrow('ffmpeg exited with code 1')
  })
})
