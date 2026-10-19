import { describe, expect, it } from 'vitest'
import {
  PERSISTENT_RECORDING_DIAGNOSTIC_ACTIONS,
  shouldLogRendererDiagnosticToAppLog
} from '../diagnostics'

describe('renderer diagnostics app-log allowlist', () => {
  it.each([
    'auto_record_decision',
    'auto_record_start_outcome',
    'recording_picker_opened',
    'recording_picker_result'
  ])('writes %s to the app log', (action) => {
    expect(PERSISTENT_RECORDING_DIAGNOSTIC_ACTIONS.has(action)).toBe(true)
    expect(shouldLogRendererDiagnosticToAppLog({ category: 'recording', action })).toBe(true)
  })

  it('keeps the recording allowlist explicit', () => {
    expect(
      shouldLogRendererDiagnosticToAppLog({ category: 'recording', action: 'recording_started' })
    ).toBe(false)
    expect(
      shouldLogRendererDiagnosticToAppLog({
        category: 'recording',
        action: 'auto_record_requested'
      })
    ).toBe(false)
    expect(
      shouldLogRendererDiagnosticToAppLog({
        category: 'navigation',
        action: 'auto_record_decision'
      })
    ).toBe(false)
    expect(
      shouldLogRendererDiagnosticToAppLog({ category: 'recording', action: 'capture_recovery_x' })
    ).toBe(true)
  })
})
