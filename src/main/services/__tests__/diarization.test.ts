import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiarizationService } from '../diarization'
import { getManagedPythonTarget } from '../managed-python'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
    getAppPath: vi.fn(() => '/mock/app'),
    isPackaged: true,
  },
}))

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}))

vi.mock('fs', () => ({
  createWriteStream: vi.fn(),
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
}))

const fsMock = vi.mocked(await import('fs/promises'))
const childProcessMock = vi.mocked(await import('child_process'))

describe('DiarizationService bootstrap resolution', () => {
  const originalPlatform = process.platform
  const originalArch = process.arch

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    })
    Object.defineProperty(process, 'arch', {
      value: 'arm64',
      configurable: true,
    })
    Object.defineProperty(process, 'resourcesPath', {
      value: '/mock/resources',
      configurable: true,
    })
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    })
    Object.defineProperty(process, 'arch', {
      value: originalArch,
      configurable: true,
    })
  })

  it('prefers a bundled packaged runtime over a system Python', async () => {
    const target = getManagedPythonTarget(process.platform, process.arch)
    expect(target).not.toBeNull()

    const bundledRuntimePython = `/mock/resources/python-runtime/${target!.key}/python/bin/python3`
    fsMock.access.mockImplementation(async (path) => {
      if (String(path) === bundledRuntimePython) return undefined
      throw new Error('ENOENT')
    })

    const service = new DiarizationService()

    const result = await (service as any).resolveBootstrapPython()

    expect(result).toBe(bundledRuntimePython)
    expect(childProcessMock.execSync).not.toHaveBeenCalled()
  })

  it('falls back to system Python when no managed runtime is available', async () => {
    fsMock.access.mockRejectedValue(new Error('ENOENT'))
    childProcessMock.execSync.mockReturnValue('/usr/bin/python3\n' as any)

    const service = new DiarizationService()
    vi.spyOn(service as any, 'provisionManagedRuntimeFromDownload').mockRejectedValue(new Error('offline'))
    const result = await (service as any).resolveBootstrapPython()

    expect(result).toBe('/usr/bin/python3')
    expect(childProcessMock.execSync).toHaveBeenCalled()
  })

  it('does not deadlock when startSetup calls ensureReady internally', async () => {
    const target = getManagedPythonTarget(process.platform, process.arch)
    expect(target).not.toBeNull()

    const bundledRuntimePython = `/mock/resources/python-runtime/${target!.key}/python/bin/python3`
    fsMock.access.mockImplementation(async (path) => {
      if (String(path) === bundledRuntimePython) return undefined
      throw new Error('ENOENT')
    })

    const service = new DiarizationService()
    vi.spyOn(service, 'isReady').mockResolvedValue(false)
    vi.spyOn(service as any, 'runCommand').mockResolvedValue(undefined)
    vi.spyOn(service as any, 'ensureModelReady').mockResolvedValue('/mock/model/community-1')
    vi.spyOn(service as any, 'isPythonEnvUsable').mockResolvedValue(true)

    await expect(service.startSetup()).resolves.toBeUndefined()
    expect(service.getSetupStatus()).toEqual({ phase: 'ready', percent: 100 })
  })

  it('uses the packaged bundled runtime directly in packaged builds', async () => {
    const target = getManagedPythonTarget(process.platform, process.arch)
    expect(target).not.toBeNull()

    const bundledRuntimePython = `/mock/resources/python-runtime/${target!.key}/python/bin/python3`
    fsMock.access.mockImplementation(async (path) => {
      if (String(path) === bundledRuntimePython) return undefined
      throw new Error('ENOENT')
    })

    const service = new DiarizationService()
    const runCommandSpy = vi.spyOn(service as any, 'runCommand').mockResolvedValue(undefined)

    vi.spyOn(service, 'isReady').mockResolvedValue(false)
    vi.spyOn(service as any, 'ensureModelReady').mockResolvedValue('/mock/model/community-1')
    vi.spyOn(service as any, 'isPythonEnvUsable').mockResolvedValue(true)

    await expect(service.ensureReady()).resolves.toBeUndefined()

    expect(runCommandSpy).not.toHaveBeenCalled()
    expect(service.getSetupStatus()).toEqual({ phase: 'downloading-speaker-model', percent: 75 })
  })

  it('fails packaged setup when the bundled runtime is missing', async () => {
    const service = new DiarizationService()

    vi.spyOn(service, 'isReady').mockResolvedValue(false)
    fsMock.access.mockRejectedValue(new Error('ENOENT'))

    await expect(service.ensureReady()).rejects.toThrow(/Bundled speaker diarization runtime is missing/)
  })
})
