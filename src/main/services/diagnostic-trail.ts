import { buildDiagnosticTrailEntry, type DiagnosticActionPayload, type DiagnosticTrailEntry } from '../../shared/diagnostics'

const MAX_TRAIL_ENTRIES = 40

let diagnosticTrail: DiagnosticTrailEntry[] = []

function pushEntry(source: DiagnosticTrailEntry['source'], payload: DiagnosticActionPayload): void {
  diagnosticTrail = [
    ...diagnosticTrail,
    buildDiagnosticTrailEntry(source, payload),
  ].slice(-MAX_TRAIL_ENTRIES)
}

export function recordMainDiagnosticAction(payload: DiagnosticActionPayload): void {
  pushEntry('main', payload)
}

export function recordRendererDiagnosticAction(payload: DiagnosticActionPayload): void {
  pushEntry('renderer', payload)
}

export function getDiagnosticTrail(): DiagnosticTrailEntry[] {
  return diagnosticTrail
}

export function clearDiagnosticTrail(): void {
  diagnosticTrail = []
}
