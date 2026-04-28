import { buildDiagnosticTrailEntry, type DiagnosticActionPayload, type DiagnosticTrailEntry } from '../../../shared/diagnostics'

const MAX_TRAIL_ENTRIES = 40

let analyticsConsentEnabled = false
let diagnosticTrail: DiagnosticTrailEntry[] = []

function pushLocalEntry(payload: DiagnosticActionPayload): void {
  diagnosticTrail = [
    ...diagnosticTrail,
    buildDiagnosticTrailEntry('renderer', payload),
  ].slice(-MAX_TRAIL_ENTRIES)
}

export function setDiagnosticConsentEnabled(enabled: boolean): void {
  analyticsConsentEnabled = enabled

  if (!enabled) {
    diagnosticTrail = []
    void window.electronAPI.invoke('diagnostics:clear-trail').catch(() => {})
  }
}

export function recordDiagnosticAction(payload: DiagnosticActionPayload): void {
  pushLocalEntry(payload)

  if (!analyticsConsentEnabled) return

  void window.electronAPI.invoke('diagnostics:record-action', payload).catch(() => {})
}

export function recordPersistentDiagnosticAction(payload: DiagnosticActionPayload): void {
  pushLocalEntry(payload)
  void window.electronAPI.invoke('diagnostics:record-action', payload).catch(() => {})
}

export function getRendererDiagnosticTrail(): DiagnosticTrailEntry[] {
  return diagnosticTrail
}
