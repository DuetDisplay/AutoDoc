import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { resolveWindowsMeetingDetectorPath } from '../windows-meeting-detector'

const mocks = vi.hoisted(() => ({ packaged: true, exists: vi.fn((_path: string) => true) }))
vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    getAppPath: () => '/bundle/app.asar',
    get isPackaged() {
      return mocks.packaged
    }
  }
}))
vi.mock('fs', () => ({ existsSync: mocks.exists }))

describe('Windows bundled helper resolution', () => {
  afterEach(() => vi.restoreAllMocks())
  it('never selects a working-directory executable in a packaged app', () => {
    mocks.packaged = true
    mocks.exists.mockClear()
    vi.spyOn(process, 'cwd').mockReturnValue('/untrusted')
    const resources = process.resourcesPath ?? '/bundle/app.asar'
    expect(resolveWindowsMeetingDetectorPath()).toBe(
      join(
        resources,
        'app.asar.unpacked',
        'native',
        'win-meeting-detector',
        'bin',
        'win-meeting-detector.exe'
      )
    )
    expect(
      mocks.exists.mock.calls.some(([candidate]) => String(candidate).includes('untrusted'))
    ).toBe(false)
  })
  it('fails closed rather than using a cwd helper when packaged resources are missing', () => {
    mocks.packaged = true
    vi.spyOn(process, 'cwd').mockReturnValue('/untrusted')
    mocks.exists.mockImplementation((candidate) => candidate.includes('untrusted'))
    expect(resolveWindowsMeetingDetectorPath()).toBeNull()
  })
})
