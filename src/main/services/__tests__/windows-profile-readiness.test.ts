import { afterAll, beforeEach, expect, it, vi } from 'vitest'
const originalPlatform = vi.hoisted(() => {
  const value = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  return value
})
vi.mock('electron', () => ({ app: { getPath: () => '/unused', isPackaged: false } }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))
vi.mock('../windows-transcription-runtime', async (importOriginal) => {
  const real = await importOriginal<typeof import('../windows-transcription-runtime')>()
  return {
    ...real,
    detectWindowsHardwareProfile: vi.fn(),
    loadWindowsTranscriptionProfiles: vi
      .fn()
      .mockResolvedValue(real.WINDOWS_TRANSCRIPTION_PROFILES),
    getSystemMemorySnapshot: () => ({ totalMemoryGiB: 15.3, freeMemoryGiB: 6 })
  }
})
import { WhisperManager } from '../whisper-manager'
import {
  detectWindowsHardwareProfile,
  loadWindowsTranscriptionProfiles,
  type WindowsHardwareProfile
} from '../windows-transcription-runtime'
const hardware: WindowsHardwareProfile = {
  platform: 'win32',
  arch: 'x64',
  logicalProcessors: 16,
  totalMemoryGiB: 15.3,
  freeMemoryGiB: 6,
  gpus: [{ name: 'NVIDIA RTX 4050', vendor: 'nvidia', adapterRamGiB: 6 }]
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(detectWindowsHardwareProfile).mockResolvedValue(hardware)
})
afterAll(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

it('resolves the GPU backend before returning the first notes profile on Victor hardware', async () => {
  const manager = new WhisperManager()
  expect((await manager.getEffectiveWindowsProcessingProfile())?.notesModel).toBe(
    'qwen3:4b-instruct'
  )
  expect(manager.getTranscriptionBackend()).toBe('parakeet-gpu')
})

it('joins concurrent startup and profile requests', async () => {
  const manager = new WhisperManager()
  await Promise.all([
    manager.resolveWindowsTranscriptionBackend(),
    manager.getEffectiveWindowsProcessingProfile(),
    manager.getEffectiveWindowsProcessingProfile()
  ])
  expect(loadWindowsTranscriptionProfiles).toHaveBeenCalledTimes(1)
})

it('awaits the in-flight CPU downgrade refresh before approving the next profile', async () => {
  const manager = new WhisperManager()
  await manager.resolveWindowsTranscriptionBackend()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.mocked(detectWindowsHardwareProfile).mockImplementationOnce(async () => {
    await pending
    return hardware
  })
  manager.downgradeParakeetGpuToCpuForSession()
  const profile = manager.getEffectiveWindowsProcessingProfile()
  release()
  expect((await profile)?.notesModel).toBe('llama3.2:3b')
})

it('does not let a late backend resolution overwrite a session CPU downgrade', async () => {
  const manager = new WhisperManager()
  await manager.resolveWindowsTranscriptionBackend()
  const profiles = vi.mocked(loadWindowsTranscriptionProfiles).mock.results[0].value
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.mocked(loadWindowsTranscriptionProfiles).mockImplementationOnce(async () => {
    await pending
    return profiles
  })
  const resolving = (
    manager as unknown as { selectWindowsProfile(): Promise<void> }
  ).selectWindowsProfile()
  await vi.waitFor(() => expect(loadWindowsTranscriptionProfiles).toHaveBeenCalledTimes(2))
  manager.downgradeParakeetGpuToCpuForSession()
  const effective = manager.getEffectiveWindowsProcessingProfile()
  release()
  await resolving
  expect((await effective)?.notesModel).toBe('llama3.2:3b')
  expect(manager.getTranscriptionBackend()).toBe('parakeet-cpu')
})

it('returns an explicit conservative profile if hardware probing fails', async () => {
  vi.mocked(detectWindowsHardwareProfile).mockRejectedValue(new Error('probe failed'))
  const manager = new WhisperManager()
  const effective = await manager.getEffectiveWindowsProcessingProfile()
  expect(effective?.id).toBe('win-low-spec')
  expect(effective?.notesModel).toBe('llama3.2:3b')
})

it('keeps the GPU disabled across fresh selections, but allows it in a fresh manager', async () => {
  const manager = new WhisperManager()
  await manager.resolveWindowsTranscriptionBackend()
  manager.downgradeParakeetGpuToCpuForSession()
  for (let attempt = 0; attempt < 3; attempt++) {
    await (manager as unknown as { selectWindowsProfile(): Promise<void> }).selectWindowsProfile()
    expect(manager.getTranscriptionBackend()).toBe('parakeet-cpu')
    expect((await manager.getEffectiveWindowsProcessingProfile())?.id).toBe('win-low-spec')
  }
  const restarted = new WhisperManager()
  await restarted.resolveWindowsTranscriptionBackend()
  expect(restarted.getTranscriptionBackend()).toBe('parakeet-gpu')
})

it('applies a session downgrade only once', async () => {
  const manager = new WhisperManager()
  await manager.resolveWindowsTranscriptionBackend()
  expect(manager.downgradeParakeetGpuToCpuForSession()).toBe(true)
  const revision = (manager as unknown as { windowsBackendRevision: number }).windowsBackendRevision
  expect(manager.downgradeParakeetGpuToCpuForSession()).toBe(false)
  expect((manager as unknown as { windowsBackendRevision: number }).windowsBackendRevision).toBe(
    revision
  )
  expect(manager.getDowngradesTaken()).toEqual(['parakeet-gpu→parakeet-cpu'])
})

it('also keeps CPU selected after setup-time GPU failure', async () => {
  const manager = new WhisperManager()
  await manager.resolveWindowsTranscriptionBackend()
  const internal = manager as unknown as {
    ensureParakeetReady(): Promise<void>
    ensureParakeetWithFallback(): Promise<boolean>
    selectWindowsProfile(): Promise<void>
  }
  const prepare = vi
    .spyOn(internal, 'ensureParakeetReady')
    .mockRejectedValueOnce(new Error('GPU probe failed'))
    .mockResolvedValue(undefined)
  expect(await internal.ensureParakeetWithFallback()).toBe(true)
  expect(prepare).toHaveBeenCalledTimes(2)
  await internal.selectWindowsProfile()
  expect(manager.getTranscriptionBackend()).toBe('parakeet-cpu')
  expect(manager.getDowngradesTaken()).toEqual(['parakeet-gpu→parakeet-cpu'])
})

it('invalidates an in-flight selection when setup falls back from GPU', async () => {
  const manager = new WhisperManager()
  await manager.resolveWindowsTranscriptionBackend()
  const internal = manager as unknown as {
    windowsBackendRevision: number
    ensureParakeetReady(): Promise<void>
    ensureParakeetWithFallback(): Promise<boolean>
    selectWindowsProfile(): Promise<void>
  }
  const revision = internal.windowsBackendRevision
  const profiles = vi.mocked(loadWindowsTranscriptionProfiles).mock.results[0].value
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.mocked(loadWindowsTranscriptionProfiles).mockImplementationOnce(async () => {
    await pending
    return profiles
  })
  const selection = internal.selectWindowsProfile()
  await vi.waitFor(() => expect(loadWindowsTranscriptionProfiles).toHaveBeenCalledTimes(2))
  vi.spyOn(internal, 'ensureParakeetReady')
    .mockRejectedValueOnce(new Error('GPU probe failed'))
    .mockResolvedValue(undefined)
  expect(await internal.ensureParakeetWithFallback()).toBe(true)
  expect(internal.windowsBackendRevision).toBe(revision + 1)
  release()
  await selection
  expect(manager.getTranscriptionBackend()).toBe('parakeet-cpu')
})
