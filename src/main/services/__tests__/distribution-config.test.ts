import { afterEach, describe, expect, it } from 'vitest'
import {
  getConfiguredAuthWorkerUrl,
  getConfiguredMacWhisperRuntimeAssetBaseUrl,
  getConfiguredWindowsTranscriptionAssetBaseUrl,
  isOfficialAutoDocBuild
} from '../distribution-config'

afterEach(() => {
  delete process.env.AUTODOC_OFFICIAL_BUILD
  delete process.env.AUTODOC_AUTH_WORKER_URL
  delete process.env.AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL
  delete process.env.AUTODOC_MACOS_WHISPER_RUNTIME_RELEASE_TAG
  delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
  delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_RELEASE_TAG
})

describe('distribution config', () => {
  it('fails closed for private infrastructure while allowing public Windows assets', () => {
    expect(isOfficialAutoDocBuild()).toBe(false)
    expect(getConfiguredAuthWorkerUrl()).toBeNull()
    expect(getConfiguredMacWhisperRuntimeAssetBaseUrl()).toBeNull()
    expect(getConfiguredWindowsTranscriptionAssetBaseUrl()).toBe(
      'https://github.com/DuetDisplay/AutoDoc-Windows-Assets/releases/download/windows-transcription-v2'
    )
  })

  it('uses official infrastructure defaults for official builds', () => {
    process.env.AUTODOC_OFFICIAL_BUILD = '1'

    expect(getConfiguredAuthWorkerUrl()).toBe('https://autodoc-auth.duetdisplay.workers.dev')
    expect(getConfiguredMacWhisperRuntimeAssetBaseUrl()).toBe(
      'https://github.com/DuetDisplay/AutoDoc/releases/download/macos-whisper-runtime-v1'
    )
    expect(getConfiguredWindowsTranscriptionAssetBaseUrl()).toBe(
      'https://github.com/DuetDisplay/AutoDoc-Windows-Assets/releases/download/windows-transcription-v2'
    )
  })

  it('prefers explicit overrides over official defaults', () => {
    process.env.AUTODOC_OFFICIAL_BUILD = '1'
    process.env.AUTODOC_AUTH_WORKER_URL = 'https://fork.example.com/auth'
    process.env.AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL = 'https://fork.example.com/macos'
    process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL = 'https://fork.example.com/windows'

    expect(getConfiguredAuthWorkerUrl()).toBe('https://fork.example.com/auth')
    expect(getConfiguredMacWhisperRuntimeAssetBaseUrl()).toBe('https://fork.example.com/macos')
    expect(getConfiguredWindowsTranscriptionAssetBaseUrl()).toBe('https://fork.example.com/windows')
  })
})
