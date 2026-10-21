export type DiagnosticCategory =
  | 'app'
  | 'navigation'
  | 'recording'
  | 'calendar'
  | 'search'
  | 'chat'
  | 'onboarding'
  | 'settings'
  | 'system'

export interface DiagnosticActionPayload {
  category: DiagnosticCategory
  action: string
  details?: Record<string, unknown>
}

export interface DiagnosticTrailEntry {
  timestamp: string
  source: 'renderer' | 'main'
  category: DiagnosticCategory
  action: string
  [key: string]: unknown
}

function normalizeDiagnosticDetailValue(value: unknown): unknown {
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function buildDiagnosticTrailEntry(
  source: DiagnosticTrailEntry['source'],
  payload: DiagnosticActionPayload
): DiagnosticTrailEntry {
  const entry: DiagnosticTrailEntry = {
    timestamp: new Date().toISOString(),
    source,
    category: payload.category,
    action: payload.action
  }

  for (const [key, value] of Object.entries(payload.details ?? {})) {
    entry[`detail_${key}`] = normalizeDiagnosticDetailValue(value)
  }

  return entry
}

/**
 * Recording actions that always reach autodocLog, with no analytics consent, because they
 * explain the meeting-detection -> auto-record -> window-selection flow for QA. Keep this
 * list explicit; their details must carry ids, booleans, counts and scores only.
 */
export const PERSISTENT_RECORDING_DIAGNOSTIC_ACTIONS: ReadonlySet<string> = new Set([
  'auto_record_decision',
  'auto_record_start_outcome',
  'recording_picker_opened',
  'recording_picker_result'
])

/** True when a renderer diagnostic action is copied into the app log in the main process. */
export function shouldLogRendererDiagnosticToAppLog(payload: DiagnosticActionPayload): boolean {
  if (payload.category === 'system' || payload.category === 'onboarding') return true
  return (
    payload.category === 'recording' &&
    (payload.action.startsWith('capture_recovery_') ||
      PERSISTENT_RECORDING_DIAGNOSTIC_ACTIONS.has(payload.action))
  )
}
