const OFFICIAL_AUTH_WORKER_URL = 'https://autodoc-auth.duetdisplay.workers.dev'
const DEFAULT_MAC_WHISPER_RUNTIME_RELEASE_TAG = 'macos-whisper-runtime-v1'
const DEFAULT_WINDOWS_TRANSCRIPTION_RELEASE_TAG = 'windows-transcription-v1'

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

export function isOfficialAutoDocBuild(): boolean {
  return process.env.AUTODOC_OFFICIAL_BUILD === '1'
}

export function getConfiguredAuthWorkerUrl(): string | null {
  return readEnv('AUTODOC_AUTH_WORKER_URL') ?? (isOfficialAutoDocBuild() ? OFFICIAL_AUTH_WORKER_URL : null)
}

export function requireConfiguredAuthWorkerUrl(): string {
  return (
    getConfiguredAuthWorkerUrl() ??
    (() => {
      throw new Error(
        'Calendar OAuth is not configured for this build. Set AUTODOC_AUTH_WORKER_URL to your own auth worker URL.'
      )
    })()
  )
}

export function getConfiguredMacWhisperRuntimeAssetBaseUrl(): string | null {
  const override = readEnv('AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL')
  if (override) {
    return override
  }
  if (!isOfficialAutoDocBuild()) {
    return null
  }

  const releaseTag =
    readEnv('AUTODOC_MACOS_WHISPER_RUNTIME_RELEASE_TAG') ??
    DEFAULT_MAC_WHISPER_RUNTIME_RELEASE_TAG
  return `https://github.com/DuetDisplay/AutoDoc-Local/releases/download/${releaseTag}`
}

export function getConfiguredWindowsTranscriptionAssetBaseUrl(): string | null {
  const override = readEnv('AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL')
  if (override) {
    return override
  }
  if (!isOfficialAutoDocBuild()) {
    return null
  }

  const releaseTag =
    readEnv('AUTODOC_WINDOWS_TRANSCRIPTION_RELEASE_TAG') ??
    DEFAULT_WINDOWS_TRANSCRIPTION_RELEASE_TAG
  return `https://github.com/DuetDisplay/AutoDoc-Local/releases/download/${releaseTag}`
}
