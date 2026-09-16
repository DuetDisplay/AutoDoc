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
