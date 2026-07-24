import { describe, expect, it } from 'vitest'
import {
  QA_GATE_CPU_FIRST_RUN_MAX_BYTES,
  QA_GATE_GPU_FIRST_RUN_MAX_BYTES,
  QA_GATE_GPU_STOP_TO_TRANSCRIPT_SEC,
  classifyWindowsTranscriptionTier,
  evaluateFirstRunDownloadGate,
  evaluateLongMeetingStopToTranscriptGate
} from '../qa-gate-log'

describe('qa gate helpers', () => {
  it('classifies GPU backends by device and id', () => {
    expect(classifyWindowsTranscriptionTier({ backendId: 'parakeet-gpu', device: 'dml' })).toBe(
      'gpu'
    )
    expect(
      classifyWindowsTranscriptionTier({ backendId: 'faster-whisper-cuda', device: 'cuda' })
    ).toBe('gpu')
  })

  it('classifies CPU backends by device and id', () => {
    expect(classifyWindowsTranscriptionTier({ backendId: 'parakeet-cpu', device: 'cpu' })).toBe(
      'cpu'
    )
    expect(classifyWindowsTranscriptionTier({ backendId: 'whisper-cpp', device: 'cpu' })).toBe(
      'cpu'
    )
  })

  it('marks long GPU meetings under the 5 minute gate as pass', () => {
    const gate = evaluateLongMeetingStopToTranscriptGate({
      recordingDurationSec: 60 * 60,
      stopToTranscriptWallSec: 4 * 60 + 30,
      tier: 'gpu'
    })

    expect(gate.applicable).toBe(true)
    expect(gate.targetWallSec).toBe(QA_GATE_GPU_STOP_TO_TRANSCRIPT_SEC)
    expect(gate.pass).toBe(true)
  })

  it('does not apply the long-meeting gate to short recordings', () => {
    const gate = evaluateLongMeetingStopToTranscriptGate({
      recordingDurationSec: 3 * 60,
      stopToTranscriptWallSec: 10 * 60,
      tier: 'gpu'
    })

    expect(gate.applicable).toBe(false)
    expect(gate.pass).toBeNull()
  })

  it('evaluates first-run download budgets by tier', () => {
    expect(
      evaluateFirstRunDownloadGate({
        tier: 'cpu',
        totalDownloadedBytes: QA_GATE_CPU_FIRST_RUN_MAX_BYTES - 1
      }).pass
    ).toBe(true)
    expect(
      evaluateFirstRunDownloadGate({
        tier: 'gpu',
        totalDownloadedBytes: QA_GATE_GPU_FIRST_RUN_MAX_BYTES + 1
      }).pass
    ).toBe(false)
  })
})
