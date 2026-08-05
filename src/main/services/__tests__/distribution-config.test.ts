import { afterEach, describe, expect, it } from 'vitest'
import {
  getConfiguredAuthWorkerUrl,
  getConfiguredMacWhisperRuntimeAssetBaseUrl,
  getConfiguredWindowsTranscriptionAssetBaseUrl,
  getSupportEmail,
  requireSupportEmail,
  isOfficialAutoDocBuild
} from '../distribution-config'

afterEach(() => {
  delete process.env.AUTODOC_OFFICIAL_BUILD
  delete process.env.AUTODOC_AUTH_WORKER_URL
  delete process.env.AUTODOC_SUPPORT_EMAIL
  delete process.env.AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL
  delete process.env.AUTODOC_MACOS_WHISPER_RUNTIME_RELEASE_TAG
  delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
  delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_RELEASE_TAG
})

describe('distribution config', () => {
  it('fails closed for private infrastructure while allowing public Windows assets', () => {
    expect(isOfficialAutoDocBuild()).toBe(false)
    expect(getConfiguredAuthWorkerUrl()).toBeNull()
    expect(getSupportEmail()).toBeNull()
    expect(getConfiguredMacWhisperRuntimeAssetBaseUrl()).toBeNull()
    expect(getConfiguredWindowsTranscriptionAssetBaseUrl()).toBe(
      'https://github.com/DuetDisplay/AutoDoc/releases/download/windows-transcription-v2'
    )
  })

  it('uses official infrastructure defaults for official builds', () => {
    process.env.AUTODOC_OFFICIAL_BUILD = '1'

    expect(getConfiguredAuthWorkerUrl()).toBe('https://autodoc-auth.duetdisplay.workers.dev')
    expect(getSupportEmail()).toBe('team@getautodoc.com')
    expect(getConfiguredMacWhisperRuntimeAssetBaseUrl()).toBe(
      'https://github.com/DuetDisplay/AutoDoc/releases/download/macos-whisper-runtime-v1'
    )
    expect(getConfiguredWindowsTranscriptionAssetBaseUrl()).toBe(
      'https://github.com/DuetDisplay/AutoDoc/releases/download/windows-transcription-v2'
    )
  })

  it('prefers explicit overrides over official defaults', () => {
    process.env.AUTODOC_OFFICIAL_BUILD = '1'
    process.env.AUTODOC_AUTH_WORKER_URL = 'https://fork.example.com/auth'
    process.env.AUTODOC_SUPPORT_EMAIL = 'help@fork.example.com'
    process.env.AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL = 'https://fork.example.com/macos'
    process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL = 'https://fork.example.com/windows'

    expect(getConfiguredAuthWorkerUrl()).toBe('https://fork.example.com/auth')
    expect(getSupportEmail()).toBe('help@fork.example.com')
    expect(getConfiguredMacWhisperRuntimeAssetBaseUrl()).toBe('https://fork.example.com/macos')
    expect(getConfiguredWindowsTranscriptionAssetBaseUrl()).toBe('https://fork.example.com/windows')
  })

  it('normalizes a valid support address', () => {
    process.env.AUTODOC_SUPPORT_EMAIL = '  help+desktop@example.com  '

    expect(getSupportEmail()).toBe('help+desktop@example.com')
    expect(requireSupportEmail()).toBe('help+desktop@example.com')
  })

  it.each([
    'first@example.com,second@example.com',
    'AutoDoc Team <team@example.com>',
    'team@example.com?bcc=attacker@example.com',
    'team@example.com#fragment',
    'team@example.com%0abcc=attacker@example.com',
    'team@example.com\r\nbcc:attacker@example.com',
    'team@example.com;attacker@example.com',
    'team @example.com',
    '.team@example.com',
    'team..support@example.com',
    'team@-example.com',
    'team@example'
  ])('rejects malformed or injectable support address %j', (email) => {
    process.env.AUTODOC_OFFICIAL_BUILD = '1'
    process.env.AUTODOC_SUPPORT_EMAIL = email

    expect(getSupportEmail()).toBeNull()
    expect(() => requireSupportEmail()).toThrow('Support email is not configured')
  })
})
