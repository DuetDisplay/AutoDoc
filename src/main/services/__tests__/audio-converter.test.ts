import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AudioConverter } from '../audio-converter'

vi.mock('child_process', () => ({
  spawn: vi.fn()
}))

const mockSpawn = vi.mocked(await import('child_process')).spawn

function createMockProcess(exitCode: number, stderr = '') {
  const proc = {
    on: vi.fn((event: string, cb: (exitCode: number) => void) => {
      if (event === 'close') {
        setTimeout(() => cb(exitCode), 0)
      }
      return proc
    }),
    stderr: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data' && stderr) {
          setTimeout(() => cb(Buffer.from(stderr)), 0)
        }
        return proc.stderr
      })
    }
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

    expect(mockSpawn).toHaveBeenCalledWith('/bin/ffmpeg', [
      '-i',
      '/input/audio.webm',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      '-y',
      '/output/audio.wav'
    ])
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

  it('tags ffmpeg exit failures with a sentryFingerprint per step', async () => {
    const cases: Array<[string, () => Promise<void>, string]> = [
      ['convert', () => converter.convert('/in.webm', '/out.wav', '/bin/ffmpeg'), 'convert'],
      ['merge', () => converter.mergeAudio('/a.wav', '/b.wav', '/out.wav', '/bin/ffmpeg'), 'merge'],
      [
        'extract',
        () => converter.extractClip('/in.wav', '/out.wav', '/bin/ffmpeg', 1, 2),
        'extract'
      ]
    ]
    for (const [, run, step] of cases) {
      mockSpawn.mockReturnValue(createMockProcess(228, 'No space left on device') as any)
      const error = await run().then(
        () => null,
        (err: Error & { sentryFingerprint?: string[] }) => err
      )
      expect(error?.message).toContain('No space left on device')
      expect(error?.sentryFingerprint).toEqual(['ffmpeg-exit', step, '228'])
    }
  })

  it('tags concat failures with a sentryFingerprint', async () => {
    mockSpawn.mockReturnValue(createMockProcess(1, 'bad concat') as any)
    const error = await converter
      .concatClips(['/a.wav'], '/out.wav', '/bin/ffmpeg', '/tmp/autodoc-concat-test.txt')
      .then(
        () => null,
        (err: Error & { sentryFingerprint?: string[] }) => err
      )
    expect(error?.sentryFingerprint).toEqual(['ffmpeg-exit', 'concat', '1'])
  })
})
