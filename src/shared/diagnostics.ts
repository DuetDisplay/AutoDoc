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
    value == null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
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
  payload: DiagnosticActionPayload,
): DiagnosticTrailEntry {
  const entry: DiagnosticTrailEntry = {
    timestamp: new Date().toISOString(),
    source,
    category: payload.category,
    action: payload.action,
  }

  for (const [key, value] of Object.entries(payload.details ?? {})) {
    entry[`detail_${key}`] = normalizeDiagnosticDetailValue(value)
  }

  return entry
}
