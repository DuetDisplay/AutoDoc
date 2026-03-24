import { describe, it, expect, beforeEach } from 'vitest'
import { useRecordingStore } from '../recording'

describe('useRecordingStore', () => {
  beforeEach(() => {
    useRecordingStore.setState({
      isRecording: false,
      meetingId: null,
      startedAt: null,
      sourceId: null,
      sourceName: null,
      elapsedSeconds: 0,
      sources: [],
      isLoadingSources: false,
    })
  })

  it('starts with idle state', () => {
    const state = useRecordingStore.getState()
    expect(state.isRecording).toBe(false)
    expect(state.meetingId).toBeNull()
    expect(state.sources).toEqual([])
  })

  it('updates recording state', () => {
    useRecordingStore.getState().setRecordingState({
      isRecording: true,
      meetingId: 'test-123',
      startedAt: Date.now(),
      sourceId: 'source-1',
      sourceName: 'Zoom',
    })

    const state = useRecordingStore.getState()
    expect(state.isRecording).toBe(true)
    expect(state.meetingId).toBe('test-123')
  })

  it('increments elapsed seconds', () => {
    useRecordingStore.getState().tick()
    expect(useRecordingStore.getState().elapsedSeconds).toBe(1)
    useRecordingStore.getState().tick()
    expect(useRecordingStore.getState().elapsedSeconds).toBe(2)
  })

  it('resets elapsed on new recording', () => {
    useRecordingStore.getState().tick()
    useRecordingStore.getState().tick()
    useRecordingStore.getState().setRecordingState({
      isRecording: true,
      meetingId: 'new',
      startedAt: Date.now(),
      sourceId: 's',
      sourceName: 'n',
    })
    expect(useRecordingStore.getState().elapsedSeconds).toBe(0)
  })

  it('sets sources', () => {
    useRecordingStore.getState().setSources([
      { id: 's1', name: 'Zoom', thumbnailDataUrl: 'data:...' },
    ])
    expect(useRecordingStore.getState().sources).toHaveLength(1)
    expect(useRecordingStore.getState().sources[0].name).toBe('Zoom')
  })
})
