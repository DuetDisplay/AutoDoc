// src/renderer/src/__tests__/recording-flow.test.tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { useRecordingStore } from '../stores/recording'
import { detectMeetingWindow } from '../services/window-detection'
import type { RecordingSource } from '../../../shared/types'

describe('Recording flow integration', () => {
  beforeEach(() => {
    useRecordingStore.getState().reset()
  })

  it('full state lifecycle: idle -> recording -> stopped', () => {
    const store = useRecordingStore

    // Initial state
    expect(store.getState().isRecording).toBe(false)
    expect(store.getState().meetingId).toBeNull()

    // Start recording
    store.getState().setRecordingState({
      isRecording: true,
      meetingId: 'meeting-1',
      startedAt: 1000,
      sourceId: 'window:1',
      sourceName: 'Zoom Meeting',
    })

    expect(store.getState().isRecording).toBe(true)
    expect(store.getState().meetingId).toBe('meeting-1')
    expect(store.getState().sourceName).toBe('Zoom Meeting')
    expect(store.getState().elapsedSeconds).toBe(0)

    // Timer ticks
    store.getState().tick()
    store.getState().tick()
    store.getState().tick()
    expect(store.getState().elapsedSeconds).toBe(3)

    // Stop recording
    store.getState().reset()
    expect(store.getState().isRecording).toBe(false)
    expect(store.getState().meetingId).toBeNull()
    expect(store.getState().elapsedSeconds).toBe(0)
  })

  it('window detection integrates with source selection', () => {
    const sources: RecordingSource[] = [
      { id: 'window:1', name: 'Zoom Meeting - Standup', thumbnailDataUrl: '' },
      { id: 'window:2', name: 'Visual Studio Code', thumbnailDataUrl: '' },
      { id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' },
    ]

    const detected = detectMeetingWindow(sources)
    expect(detected).not.toBeNull()
    expect(detected!.name).toContain('Zoom')

    // Simulate using detected window to start recording
    useRecordingStore.getState().setRecordingState({
      isRecording: true,
      meetingId: 'meeting-2',
      startedAt: Date.now(),
      sourceId: detected!.id,
      sourceName: detected!.name,
    })

    expect(useRecordingStore.getState().sourceName).toContain('Zoom')
  })
})
