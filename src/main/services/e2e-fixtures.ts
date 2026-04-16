import type { E2EScenario } from '../../shared/e2e'
import type {
  CalendarAccount,
  CalendarEvent,
  OllamaSetupStatus,
  RecordingSource,
  WhisperSetupStatus,
} from '../../shared/types'

const DEFAULT_RECORDING_SOURCES: RecordingSource[] = [
  {
    id: 'screen:e2e-display',
    name: 'E2E Display',
    thumbnailDataUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2p8i4AAAAASUVORK5CYII=',
  },
]

const DEFAULT_WHISPER_STATUS: WhisperSetupStatus = {
  phase: 'ready',
  percent: 100,
}

const DEFAULT_OLLAMA_STATUS: OllamaSetupStatus = {
  phase: 'ready',
  percent: 100,
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function parseScenario(): E2EScenario {
  const raw = process.env.AUTODOC_E2E_SCENARIO
  if (!raw) {
    return {}
  }

  try {
    return JSON.parse(raw) as E2EScenario
  } catch (error) {
    console.warn('Failed to parse AUTODOC_E2E_SCENARIO:', error)
    return {}
  }
}

const scenario = parseScenario()
const platform = scenario.platform ?? process.platform
const permissions = {
  microphone: scenario.permissions?.microphone ?? (platform === 'win32'),
  screen: scenario.permissions?.screen ?? (platform === 'win32'),
}
const whisperRetryStatuses = [...(scenario.whisper?.retryStatuses ?? [])]
const ollamaRetryStatuses = [...(scenario.ollama?.retryStatuses ?? [])]

let whisperStatus: WhisperSetupStatus = clone(
  scenario.whisper?.status ?? DEFAULT_WHISPER_STATUS,
)
let ollamaStatus: OllamaSetupStatus = clone(
  scenario.ollama?.status ?? DEFAULT_OLLAMA_STATUS,
)
let calendarAccounts: CalendarAccount[] = clone(scenario.calendar?.accounts ?? [])
const calendarEvents: CalendarEvent[] = clone(scenario.calendar?.events ?? [])
const recordingSources: RecordingSource[] = clone(
  scenario.recording?.sources ?? DEFAULT_RECORDING_SOURCES,
)

export function getE2EPermissions(): { microphone: boolean; screen: boolean } {
  return { ...permissions }
}

export function getE2EPlatform(): NodeJS.Platform {
  return platform
}

export function getE2EWhisperStatus(): WhisperSetupStatus {
  return clone(whisperStatus)
}

export function retryE2EWhisperSetup(): WhisperSetupStatus {
  const nextStatus = whisperRetryStatuses.shift() ?? scenario.whisper?.retryStatus ?? whisperStatus
  whisperStatus = clone(nextStatus)
  return getE2EWhisperStatus()
}

export function setE2EWhisperStatus(status: WhisperSetupStatus): WhisperSetupStatus {
  whisperStatus = clone(status)
  return getE2EWhisperStatus()
}

export function getE2EOllamaStatus(): OllamaSetupStatus {
  return clone(ollamaStatus)
}

export function retryE2EOllamaSetup(): OllamaSetupStatus {
  const nextStatus = ollamaRetryStatuses.shift() ?? scenario.ollama?.retryStatus ?? ollamaStatus
  ollamaStatus = clone(nextStatus)
  return getE2EOllamaStatus()
}

export function setE2EOllamaStatus(status: OllamaSetupStatus): OllamaSetupStatus {
  ollamaStatus = clone(status)
  return getE2EOllamaStatus()
}

export function getE2ECalendarAccounts(): CalendarAccount[] {
  return clone(calendarAccounts)
}

export function connectE2ECalendar(provider: 'google' | 'microsoft'): CalendarAccount {
  if (scenario.calendar?.connectSucceeds === false) {
    throw new Error(`E2E calendar connect failed for ${provider}`)
  }

  const existing = calendarAccounts.find((account) => account.provider === provider)
  if (existing) {
    return clone(existing)
  }

  const account: CalendarAccount = {
    id: `e2e-${provider}-${calendarAccounts.length + 1}`,
    provider,
    email: `e2e-${provider}@example.com`,
    connectedAt: Date.now(),
  }

  calendarAccounts = [...calendarAccounts, account]
  return clone(account)
}

export function disconnectE2ECalendar(accountId: string): void {
  calendarAccounts = calendarAccounts.filter((account) => account.id !== accountId)
}

export function getE2ECalendarEvents(): CalendarEvent[] {
  return clone(calendarEvents)
}

export function getE2ERecordingSources(): RecordingSource[] {
  return clone(recordingSources)
}
