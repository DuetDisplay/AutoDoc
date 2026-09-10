import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeInfo } from '../../test/fixtures'

const trackEvent = vi.fn()

vi.mock('../analytics', () => ({
  trackEvent
}))

describe('meeting processed analytics', () => {
  beforeEach(() => {
    trackEvent.mockClear()
  })

  it('emits one meeting_processed row after transcription and notes finish', async () => {
    const { rememberTranscriptionComplete, trackMeetingProcessed } = await import(
      '../meeting-processed-analytics'
    )
    const store = new Map()
    const emitted = new Set<string>()

    rememberTranscriptionComplete(store, 'meeting-1', 45 * 60, 8 * 60)
    expect(
      trackMeetingProcessed({
        store,
        emitted,
        meetingId: 'meeting-1',
        runtimeInfo: createRuntimeInfo({
          ramBucket: '16gb',
          cpuClass: 'recommended',
          hasGpu: true
        }),
        notesOutcome: 'generated',
        notesDurationSec: 3 * 60
      })
    ).toBe(true)

    expect(trackEvent).toHaveBeenCalledWith('meeting_processed', {
      ram_bucket: '16gb',
      cpu_class: 'recommended',
      has_gpu: true,
      recording_duration_min: 45,
      transcription_duration_min: 8,
      notes_outcome: 'generated',
      notes_duration_min: 3
    })

    expect(
      trackMeetingProcessed({
        store,
        emitted,
        meetingId: 'meeting-1',
        runtimeInfo: createRuntimeInfo(),
        notesOutcome: 'generated',
        notesDurationSec: 3 * 60
      })
    ).toBe(false)
    expect(trackEvent).toHaveBeenCalledTimes(1)
  })

  it('does not emit when transcription timing is missing', async () => {
    const { trackMeetingProcessed } = await import('../meeting-processed-analytics')

    expect(
      trackMeetingProcessed({
        store: new Map(),
        emitted: new Set(),
        meetingId: 'meeting-2',
        runtimeInfo: createRuntimeInfo(),
        notesOutcome: 'did_not_run'
      })
    ).toBe(false)
    expect(trackEvent).not.toHaveBeenCalled()
  })
})
