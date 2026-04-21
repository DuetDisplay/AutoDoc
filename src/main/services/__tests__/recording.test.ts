import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecordingService } from '../recording'

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn()
}))

// Mock crypto
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234')
}))

describe('RecordingService', () => {
  let service: RecordingService

  beforeEach(() => {
    service = new RecordingService()
  })

  it('starts with idle state', () => {
    const state = service.getState()
    expect(state.isRecording).toBe(false)
    expect(state.meetingId).toBeNull()
    expect(state.startedAt).toBeNull()
  })

  it('transitions to recording state on start', async () => {
    const paths = await service.startRecording('source-123', 'Zoom Meeting', {
      meetingSourceId: 'window:zoom',
      meetingSourceName: 'Zoom Meeting',
      providerId: 'zoom'
    })
    const state = service.getState()

    expect(state.isRecording).toBe(true)
    expect(state.meetingId).toBe('test-uuid-1234')
    expect(state.sourceId).toBe('source-123')
    expect(state.sourceName).toBe('Zoom Meeting')
    expect(state.trackedMeetingSourceId).toBe('window:zoom')
    expect(state.trackedMeetingSourceName).toBe('Zoom Meeting')
    expect(state.trackedMeetingProviderId).toBe('zoom')
    expect(paths.meetingId).toBe('test-uuid-1234')
    expect(paths.video).toContain('test-uuid-1234')
    expect(paths.video).toContain('screen.webm')
    expect(paths.audio).toContain('audio.webm')
  })

  it('transitions back to idle on stop', async () => {
    await service.startRecording('source-123', 'Zoom Meeting')
    const result = service.stopRecording()

    expect(result.meetingId).toBe('test-uuid-1234')
    expect(service.getState().isRecording).toBe(false)
    expect(service.getState().meetingId).toBeNull()
  })

  it('throws if starting while already recording', async () => {
    await service.startRecording('source-123', 'Zoom Meeting')
    await expect(service.startRecording('source-456', 'Teams')).rejects.toThrow('Already recording')
  })

  it('throws if stopping when not recording', () => {
    expect(() => service.stopRecording()).toThrow('Not recording')
  })
})
