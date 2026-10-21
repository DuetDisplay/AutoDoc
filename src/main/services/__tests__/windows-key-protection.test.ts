import { beforeEach, describe, expect, it, vi } from 'vitest'
import { protectWindowsRecordingKey, unprotectWindowsRecordingKey } from '../windows-key-protection'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), resolve: vi.fn() }))
vi.mock('child_process', () => ({ execFileSync: mocks.exec }))
vi.mock('../windows-meeting-detector', () => ({ resolveWindowsMeetingDetectorPath: mocks.resolve }))

describe('Windows key protection wrapper', () => {
  beforeEach(() => {
    mocks.exec
      .mockReset()
      .mockImplementation((_helper, args) => Buffer.alloc(args[0] === '--protect-key' ? 128 : 32))
    mocks.resolve.mockReset().mockReturnValue('/bundle/native/helper.exe')
  })

  it('sends binary key data only through private stdin/stdout pipes', () => {
    const key = Buffer.alloc(32)
    expect(protectWindowsRecordingKey(key).length).toBe(128)
    const [helper, args, options] = mocks.exec.mock.calls[0]
    expect(helper).toBe('/bundle/native/helper.exe')
    expect(args).toEqual(['--protect-key'])
    expect(options.input === key).toBe(true)
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(options.windowsHide).toBe(true)
    expect(options.timeout).toBe(5000)
    expect(options.maxBuffer).toBe(65536)
    expect('env' in options).toBe(false)
  })

  it('does not propagate subprocess errors that contain secret buffers', () => {
    mocks.exec.mockImplementation(() => {
      throw Object.assign(new Error('child error'), {
        stdout: Buffer.alloc(32),
        input: Buffer.alloc(32)
      })
    })
    let error: unknown
    try {
      protectWindowsRecordingKey(Buffer.alloc(32))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Windows recording key protection failed')
    expect('stdout' in (error as Error)).toBe(false)
    expect('input' in (error as Error)).toBe(false)
    expect('cause' in (error as Error)).toBe(false)
  })

  it('rejects malformed or oversized blobs and invalid recovered key lengths', () => {
    expect(() => protectWindowsRecordingKey(Buffer.alloc(31))).toThrow()
    expect(() => unprotectWindowsRecordingKey(Buffer.alloc(65537))).toThrow()
    expect(mocks.exec).not.toHaveBeenCalled()
    mocks.exec.mockReturnValue(Buffer.alloc(31))
    expect(() => unprotectWindowsRecordingKey(Buffer.alloc(128))).toThrow(
      'Invalid Windows recording key length'
    )
  })

  it('fails closed when the bundled helper is unavailable', () => {
    mocks.resolve.mockReturnValue(null)
    expect(() => protectWindowsRecordingKey(Buffer.alloc(32))).toThrow('helper is unavailable')
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it.each(['stale JSON output', 'different recovered key'])(
    'rejects %s before accepting a protected backup',
    (failure) => {
      mocks.exec.mockImplementation((_helper, args) => {
        if (failure === 'stale JSON output') {
          return Buffer.from('["slack.exe","chrome.exe","teams.exe","zoom.exe"]')
        }
        return args[0] === '--protect-key' ? Buffer.alloc(128) : Buffer.alloc(32, 1)
      })
      expect(() => protectWindowsRecordingKey(Buffer.alloc(32))).toThrow()
    }
  )
})
