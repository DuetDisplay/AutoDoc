const OFFICIAL_AUTH_WORKER_URL = 'https://autodoc-auth.duetdisplay.workers.dev'
const OFFICIAL_SUPPORT_EMAIL = 'team@getautodoc.com'
const DEFAULT_MAC_WHISPER_RUNTIME_RELEASE_TAG = 'macos-whisper-runtime-v1'
const DEFAULT_WINDOWS_TRANSCRIPTION_RELEASE_TAG = 'windows-transcription-v2'
const DEFAULT_WINDOWS_TRANSCRIPTION_ASSET_REPO = 'DuetDisplay/AutoDoc'

const BUILD_TIME_AUTODOC_OFFICIAL_BUILD = process.env.AUTODOC_OFFICIAL_BUILD
const BUILD_TIME_AUTH_WORKER_URL = process.env.AUTODOC_AUTH_WORKER_URL
const BUILD_TIME_SUPPORT_EMAIL = process.env.AUTODOC_SUPPORT_EMAIL
const BUILD_TIME_MAC_WHISPER_RUNTIME_ASSET_BASE_URL =
  process.env.AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL
const BUILD_TIME_MAC_WHISPER_RUNTIME_RELEASE_TAG =
  process.env.AUTODOC_MACOS_WHISPER_RUNTIME_RELEASE_TAG
const BUILD_TIME_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL =
  process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
const BUILD_TIME_WINDOWS_TRANSCRIPTION_RELEASE_TAG =
  process.env.AUTODOC_WINDOWS_TRANSCRIPTION_RELEASE_TAG

function normalizeEnvValue(value: string | undefined): string | null {
  const trimmedValue = value?.trim()
  return trimmedValue ? trimmedValue : null
}

function readRuntimeEnv(name: string): string | null {
  return normalizeEnvValue(process.env[name])
}

function readConfiguredEnv(name: string, buildTimeValue: string | undefined): string | null {
  const value = readRuntimeEnv(name) ?? normalizeEnvValue(buildTimeValue)
  return value ? value : null
}

export function isOfficialAutoDocBuild(): boolean {
  return readConfiguredEnv('AUTODOC_OFFICIAL_BUILD', BUILD_TIME_AUTODOC_OFFICIAL_BUILD) === '1'
}

export function getConfiguredAuthWorkerUrl(): string | null {
  return (
    readConfiguredEnv('AUTODOC_AUTH_WORKER_URL', BUILD_TIME_AUTH_WORKER_URL) ??
    (isOfficialAutoDocBuild() ? OFFICIAL_AUTH_WORKER_URL : null)
  )
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

function validateSupportEmail(value: string): string | null {
  if (
    value.length > 254 ||
    /[\s\r\n,;<>:?&#%]/.test(value) ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.includes('..')
  ) {
    return null
  }

  const parts = value.split('@')
  if (parts.length !== 2) {
    return null
  }

  const [localPart, domain] = parts
  if (
    !localPart ||
    localPart.length > 64 ||
    !domain ||
    domain.length > 253 ||
    !/^[A-Za-z0-9!$'*+/=_^`{|}~.-]+$/.test(localPart)
  ) {
    return null
  }

  const domainLabels = domain.split('.')
  if (
    domainLabels.length < 2 ||
    domainLabels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[A-Za-z0-9-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-')
    )
  ) {
    return null
  }

  return value
}

export function getSupportEmail(): string | null {
  const configuredEmail = readConfiguredEnv('AUTODOC_SUPPORT_EMAIL', BUILD_TIME_SUPPORT_EMAIL)
  if (configuredEmail) {
    return validateSupportEmail(configuredEmail)
  }

  return isOfficialAutoDocBuild() ? OFFICIAL_SUPPORT_EMAIL : null
}

export function requireSupportEmail(): string {
  const email = getSupportEmail()
  if (!email) {
    throw new Error(
      'Support email is not configured for this build. Set AUTODOC_SUPPORT_EMAIL to one valid email address.'
    )
  }
  return email
}

export function getConfiguredMacWhisperRuntimeAssetBaseUrl(): string | null {
  const override = readConfiguredEnv(
    'AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL',
    BUILD_TIME_MAC_WHISPER_RUNTIME_ASSET_BASE_URL
  )
  if (override) {
    return override
  }
  if (!isOfficialAutoDocBuild()) {
    return null
  }

  const releaseTag =
    readConfiguredEnv(
      'AUTODOC_MACOS_WHISPER_RUNTIME_RELEASE_TAG',
      BUILD_TIME_MAC_WHISPER_RUNTIME_RELEASE_TAG
    ) ?? DEFAULT_MAC_WHISPER_RUNTIME_RELEASE_TAG
  return `https://github.com/DuetDisplay/AutoDoc/releases/download/${releaseTag}`
}

export function getConfiguredWindowsTranscriptionAssetBaseUrl(): string | null {
  const override = readConfiguredEnv(
    'AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL',
    BUILD_TIME_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
  )
  if (override) {
    return override
  }
  const releaseTag =
    readConfiguredEnv(
      'AUTODOC_WINDOWS_TRANSCRIPTION_RELEASE_TAG',
      BUILD_TIME_WINDOWS_TRANSCRIPTION_RELEASE_TAG
    ) ?? DEFAULT_WINDOWS_TRANSCRIPTION_RELEASE_TAG
  return `https://github.com/${DEFAULT_WINDOWS_TRANSCRIPTION_ASSET_REPO}/releases/download/${releaseTag}`
}
