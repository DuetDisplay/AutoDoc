import { describe, it, expect } from 'vitest'
import { buildRecordingTrackingContext, detectMeetingWindow } from '../window-detection'
import type { RecordingSource } from '../../../../shared/types'

describe('detectMeetingWindow', () => {
  const sources: RecordingSource[] = [
    { id: 'w:1', name: 'Zoom Meeting - Sprint Planning', thumbnailDataUrl: '' },
    { id: 'w:2', name: 'Visual Studio Code', thumbnailDataUrl: '' },
    { id: 'w:3', name: 'Google Chrome - meet.google.com/abc-defg-hij', thumbnailDataUrl: '' },
    { id: 's:0', name: 'Entire Screen', thumbnailDataUrl: '' },
  ]

  it('prefers the strongest meeting window candidate', () => {
    const result = detectMeetingWindow(sources)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:3')
  })

  it('detects Google Meet in browser', () => {
    const noZoom = sources.filter((s) => !s.name.includes('Zoom'))
    const result = detectMeetingWindow(noZoom)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:3')
  })

  it('returns null when no meeting window found', () => {
    const noMeeting = [
      { id: 'w:2', name: 'Visual Studio Code', thumbnailDataUrl: '' },
      { id: 's:0', name: 'Entire Screen', thumbnailDataUrl: '' },
    ]
    const result = detectMeetingWindow(noMeeting)
    expect(result).toBeNull()
  })

  it('detects Teams window', () => {
    const teams: RecordingSource[] = [
      { id: 'w:5', name: 'Microsoft Teams - Meeting', thumbnailDataUrl: '' },
    ]
    const result = detectMeetingWindow(teams)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:5')
  })

  it('ignores screen sources', () => {
    const screenOnly: RecordingSource[] = [
      { id: 'screen:0', name: 'Zoom Entire Screen', thumbnailDataUrl: '' },
    ]
    const result = detectMeetingWindow(screenOnly)
    expect(result).toBeNull()
  })

  it('detects Google Meet via "Meet - " title pattern', () => {
    const safari: RecordingSource[] = [
      { id: 'w:10', name: 'Meet - abc-defg-hij', thumbnailDataUrl: '' },
      { id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' },
    ]
    const result = detectMeetingWindow(safari)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:10')
  })

  it('falls back to browser window when no meeting pattern matches', () => {
    const browserOnly: RecordingSource[] = [
      { id: 'w:20', name: 'Safari', thumbnailDataUrl: '' },
      { id: 'w:21', name: 'Visual Studio Code', thumbnailDataUrl: '' },
      { id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' },
    ]
    const result = detectMeetingWindow(browserOnly)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:20')
  })

  it('marks manual screen recording without meeting context as general intent', () => {
    const context = buildRecordingTrackingContext(
      { id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' },
      null
    )

    expect(context.recordingIntent).toBe('general')
    expect(context.meetingSourceId).toBeNull()
    expect(context.providerId).toBeNull()
  })

  it('marks manual meeting window recording as meeting intent', () => {
    const context = buildRecordingTrackingContext(
      { id: 'w:5', name: 'Microsoft Teams - Meeting', thumbnailDataUrl: '' },
      null
    )

    expect(context.recordingIntent).toBe('meeting')
    expect(context.meetingSourceId).toBe('w:5')
    expect(context.providerId).toBe('teams')
  })
})
