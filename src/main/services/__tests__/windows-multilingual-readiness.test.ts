import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { WINDOWS_TRANSCRIPTION_PROFILES } from '../windows-transcription-runtime'
import type { WindowsMultilingualEngineId } from '../windows-multilingual-engine'
import type { WindowsMultilingualReadinessHost } from '../windows-multilingual-readiness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/home') }
}))

const logAutodocEvent = vi.fn()
vi.mock('../autodoc-log', () => ({
  logAutodocEvent: (...args: unknown[]) => logAutodocEvent(...args),
  logAutodocFailure: vi.fn()
}))

const workerSelftest = vi.fn()
const workerDisposeAndWait = vi.fn()

vi.mock('../transcription-worker-client', () => ({
  TranscriptionWorkerClient: vi.fn(() => ({
    selftest: workerSelftest,
    dispose: vi.fn(),
    disposeAndWait: workerDisposeAndWait
  }))
}))

const spawnClose = vi.fn()
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn()
    queueMicrotask(() => {
      spawnClose(proc)
    })
    return proc
  })
}))

describe('windows-multilingual-readiness', () => {
  const nvidia = {
    vendor: 'nvidia' as const,
    name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
    vramGiB: 8,
    discrete: true,
    driverVersion: '581.95'
  }

  let userDataDir: string
  let downgrades: string[]
  let installed: Set<string>
  let ensureCalls: WindowsMultilingualEngineId[]
  let host: WindowsMultilingualReadinessHost

  beforeEach(async () => {
    vi.resetModules()
    workerSelftest.mockReset().mockResolvedValue({ ok: true })
    workerDisposeAndWait.mockReset().mockResolvedValue(undefined)
    logAutodocEvent.mockReset()
    spawnClose.mockReset().mockImplementation((proc: EventEmitter) => {
      proc.emit('close', 0)
    })
    userDataDir = await mkdtemp(join(tmpdir(), 'autodoc-ml-ready-'))
    downgrades = []
    installed = new Set()
    ensureCalls = []
    const emitter = new EventEmitter()
    host = {
      whisperManager: {
        ensureWindowsEngineAssets: vi.fn(async (engineId: WindowsMultilingualEngineId) => {
          ensureCalls.push(engineId)
        }),
        areWindowsEngineAssetsPresent: vi.fn(async () => false),
        isWindowsTranscriptionAssetPresent: vi.fn(async (filename: string) =>
          installed.has(filename)
        ),
        getWindowsEngineRuntime: vi.fn((engineId: WindowsMultilingualEngineId) => ({
          pythonPath: `/mock/${engineId}/python.exe`,
          modelPath: `/mock/${engineId}/model`,
          processEnv: { PATH: '/mock' },
          device: engineId.includes('cuda') ? 'cuda' : 'cpu',
          computeType: engineId.includes('cuda') ? 'fp32' : 'int8',
          workerEngine: engineId.startsWith('canary') ? 'canary' : 'whisper-turbo',
          cliPath: engineId === 'whisper-turbo-vulkan' ? '/mock/whisper-cli.exe' : null,
          scriptPath:
            engineId === 'whisper-turbo-vulkan' ? '/mock/whisper-cpp-turbo-transcribe.py' : null
        })),
        getWindowsTranscriptionProfiles: vi.fn(() => WINDOWS_TRANSCRIPTION_PROFILES),
        getEffectiveWindowsProcessingProfile: vi.fn(async () => ({ id: 'win-gpu' })),
        recordWindowsTranscriptionDowngrade: vi.fn((from: string, to: string) => {
          downgrades.push(`${from}→${to}`)
        }),
        getTranscriptionWorkerScriptPath: vi.fn(() => '/mock/transcription-worker.py'),
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter)
      } as unknown as WindowsMultilingualReadinessHost['whisperManager'],
      userDataDir,
      gpu: nvidia,
      profileId: 'win-gpu'
    }
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('builds Vulkan --device-name args and never emits --device', async () => {
    const { windowsVulkanBridgeDeviceNameArgs } = await import(
      '../windows-multilingual-readiness'
    )
    expect(windowsVulkanBridgeDeviceNameArgs('NVIDIA GeForce RTX 4060 Laptop GPU')).toEqual([
      '--device-name',
      'NVIDIA GeForce RTX 4060 Laptop GPU'
    ])
    expect(windowsVulkanBridgeDeviceNameArgs('  ')).toEqual([])
    expect(windowsVulkanBridgeDeviceNameArgs(null)).toEqual([])
  })

  it('reports first-use Canary CUDA download bytes and leaves English unchanged', async () => {
    const { getWindowsMeetingLanguageAvailability } = await import(
      '../windows-multilingual-readiness'
    )
    const german = await getWindowsMeetingLanguageAvailability('de', host)
    const english = await getWindowsMeetingLanguageAvailability('en', host)

    expect(german).toMatchObject({
      availability: 'available',
      engineId: 'canary-cuda',
      firstUseDownloadBytes: 1_897_898_949 + 3_680_120_548
    })
    expect(english).toEqual({
      availability: 'available',
      reason: null,
      engineId: null,
      firstUseDownloadBytes: 0,
      needsSelfTest: false
    })
    expect(german.needsSelfTest).toBe(true)
  })

  it('marks an installed GPU engine as needing a self-test until one has run', async () => {
    installed.add('canary-cuda-runtime-win-x64.zip')
    installed.add('canary-1b-v2-fp32.zip')
    const { getWindowsMeetingLanguageAvailability } = await import(
      '../windows-multilingual-readiness'
    )
    const german = await getWindowsMeetingLanguageAvailability('de', host)
    expect(german).toMatchObject({
      availability: 'available',
      engineId: 'canary-cuda',
      firstUseDownloadBytes: 0,
      needsSelfTest: true
    })
  })

  it('locks turbo on low-spec when no GPU path is available', async () => {
    const { getWindowsMeetingLanguageAvailability } = await import(
      '../windows-multilingual-readiness'
    )
    const result = await getWindowsMeetingLanguageAvailability('es', {
      ...host,
      profileId: 'win-low-spec',
      gpu: { vendor: 'none', name: '', vramGiB: null, discrete: false, driverVersion: null }
    })

    expect(result).toMatchObject({
      availability: 'locked',
      engineId: null,
      reason: 'Spanish needs a supported graphics card on this PC.'
    })
  })

  it('falls back to Canary CPU and records the downgrade when CUDA setup fails', async () => {
    const { ensureWindowsMultilingualEngineReady } = await import(
      '../windows-multilingual-readiness'
    )
    vi.mocked(host.whisperManager.ensureWindowsEngineAssets).mockImplementation(
      async (engineId: WindowsMultilingualEngineId) => {
        ensureCalls.push(engineId)
        if (engineId === 'canary-cuda') {
          throw new Error('asset install failed')
        }
      }
    )

    const ready = await ensureWindowsMultilingualEngineReady('de', undefined, host)

    expect(ready.engineId).toBe('canary-cpu')
    expect(ready.fallbackFrom).toBe('canary-cuda')
    expect(downgrades).toContain('canary-cuda→canary-cpu')
  })

  it('skips a GPU engine after a cached failed self-test', async () => {
    const {
      ensureWindowsMultilingualEngineReady,
      resolveWindowsMultilingualJobContext
    } = await import('../windows-multilingual-readiness')
    workerSelftest.mockRejectedValueOnce(new Error('cuda self-test crashed'))

    const first = await ensureWindowsMultilingualEngineReady('de', undefined, host)
    expect(first.engineId).toBe('canary-cpu')
    expect(workerSelftest).toHaveBeenCalledTimes(1)

    ensureCalls.length = 0
    workerSelftest.mockClear()
    const context = await resolveWindowsMultilingualJobContext('de', host)
    expect(context.plan.primary?.engine).toBe('canary-cpu')
    expect(context.selfTests['canary-cuda']).toBe('failed')

    const second = await ensureWindowsMultilingualEngineReady('de', undefined, host)
    expect(second.engineId).toBe('canary-cpu')
    expect(workerSelftest).not.toHaveBeenCalled()
    expect(ensureCalls).toEqual(['canary-cpu'])
  })

  it('does not self-test CPU engines', async () => {
    const { ensureWindowsMultilingualEngineReady } = await import(
      '../windows-multilingual-readiness'
    )
    const ready = await ensureWindowsMultilingualEngineReady('de', undefined, {
      ...host,
      gpu: { vendor: 'none', name: '', vramGiB: null, discrete: false, driverVersion: null }
    })

    expect(ready.engineId).toBe('canary-cpu')
    expect(ready.selfTest).toBeNull()
    expect(workerSelftest).not.toHaveBeenCalled()
  })

  it('passes --device-name and logs the resolved Vulkan device on self-test', async () => {
    const { spawn } = await import('child_process')
    const amdHost: WindowsMultilingualReadinessHost = {
      ...host,
      gpu: {
        vendor: 'amd',
        name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
        vramGiB: 8,
        discrete: true,
        driverVersion: '581.95'
      }
    }
    spawnClose.mockImplementation(
      (proc: EventEmitter & { stdout: EventEmitter }) => {
        proc.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              ok: true,
              device: 1,
              deviceName: 'NVIDIA GeForce RTX 4060 Laptop GPU'
            })
          )
        )
        proc.emit('close', 0)
      }
    )

    const { ensureWindowsMultilingualEngineReady } = await import(
      '../windows-multilingual-readiness'
    )
    const ready = await ensureWindowsMultilingualEngineReady('ja', undefined, amdHost)

    expect(ready.engineId).toBe('whisper-turbo-vulkan')
    expect(ready.gpuName).toBe('NVIDIA GeForce RTX 4060 Laptop GPU')
    expect(spawn).toHaveBeenCalled()
    const argv = vi.mocked(spawn).mock.calls[0]?.[1] as string[]
    expect(argv).toEqual(
      expect.arrayContaining([
        '--cli',
        '/mock/whisper-cli.exe',
        '--device-name',
        'NVIDIA GeForce RTX 4060 Laptop GPU',
        '--self-test'
      ])
    )
    expect(argv).not.toContain('--device')
    expect(logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Windows multilingual GPU self-test completed',
        context: expect.objectContaining({
          engineId: 'whisper-turbo-vulkan',
          result: 'passed',
          device: 1,
          deviceName: 'NVIDIA GeForce RTX 4060 Laptop GPU'
        })
      })
    )
  })
})
