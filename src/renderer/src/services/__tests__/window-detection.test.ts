import { describe, it, expect } from 'vitest'
import {
  buildRecordingTrackingContext,
  chooseAutoRecordSource,
  detectMeetingWindow
} from '../window-detection'
import type { RecordingSource } from '../../../../shared/types'

describe('detectMeetingWindow', () => {
  const sources: RecordingSource[] = [
    { id: 'w:1', name: 'Zoom Meeting - Sprint Planning', thumbnailDataUrl: '' },
    { id: 'w:2', name: 'Visual Studio Code', thumbnailDataUrl: '' },
    { id: 'w:3', name: 'Google Chrome - meet.google.com/abc-defg-hij', thumbnailDataUrl: '' },
    { id: 's:0', name: 'Entire Screen', thumbnailDataUrl: '' }
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
      { id: 's:0', name: 'Entire Screen', thumbnailDataUrl: '' }
    ]
    const result = detectMeetingWindow(noMeeting)
    expect(result).toBeNull()
  })

  it('detects Teams window', () => {
    const teams: RecordingSource[] = [
      { id: 'w:5', name: 'Microsoft Teams - Meeting', thumbnailDataUrl: '' }
    ]
    const result = detectMeetingWindow(teams)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:5')
  })

  it.each([
    [
      { id: 'w:overlay', name: 'Slack', thumbnailDataUrl: '' },
      {
        id: 'w:huddle',
        name: 'Huddle: #product - AutoDoc - Slack',
        thumbnailDataUrl: ''
      }
    ],
    [
      {
        id: 'w:huddle',
        name: 'Huddle: #product - AutoDoc - Slack',
        thumbnailDataUrl: ''
      },
      { id: 'w:overlay', name: 'Slack', thumbnailDataUrl: '' }
    ]
  ])('prefers a Slack Huddle over the generic Slack shell in either source order', (...ordered) => {
    const selection = chooseAutoRecordSource(ordered, {
      eventId: null,
      recurringEventId: null,
      providerHint: 'slack'
    })

    expect(selection.source?.id).toBe('w:huddle')
    expect(selection.confidence).toBe('high')
  })

  it('does not let a stale remembered generic Slack name override a Huddle', () => {
    const selection = chooseAutoRecordSource(
      [
        { id: 'w:overlay', name: 'Slack', thumbnailDataUrl: '' },
        {
          id: 'w:huddle',
          name: 'Huddle: #product - AutoDoc - Slack',
          thumbnailDataUrl: ''
        }
      ],
      {
        eventId: null,
        recurringEventId: null,
        providerHint: 'slack'
      },
      {
        sourceId: 'w:stale',
        sourceName: 'Slack',
        updatedAt: Date.now()
      }
    )

    expect(selection.source?.id).toBe('w:huddle')
    expect(selection.method).toBe('meeting_pattern')
  })

  it('keeps an exact remembered source ID stronger than title ranking', () => {
    const selection = chooseAutoRecordSource(
      [
        { id: 'w:overlay', name: 'Slack', thumbnailDataUrl: '' },
        {
          id: 'w:huddle',
          name: 'Huddle: #product - AutoDoc - Slack',
          thumbnailDataUrl: ''
        }
      ],
      {
        eventId: null,
        recurringEventId: null,
        providerHint: 'slack'
      },
      {
        sourceId: 'w:overlay',
        sourceName: 'Slack',
        updatedAt: Date.now()
      }
    )

    expect(selection.source?.id).toBe('w:overlay')
    expect(selection.method).toBe('remembered_source')
    expect(selection.confidence).toBe('high')
  })

  it('treats an unresolved top-score tie as ambiguous', () => {
    const selection = chooseAutoRecordSource([
      { id: 'w:slack', name: 'Slack', thumbnailDataUrl: '' },
      { id: 'w:zoom', name: 'Zoom', thumbnailDataUrl: '' }
    ])

    expect(selection.source).toBeNull()
    expect(selection.confidence).toBe('none')
    expect(selection.method).toBe('none')
  })

  it('ignores screen sources', () => {
    const screenOnly: RecordingSource[] = [
      { id: 'screen:0', name: 'Zoom Entire Screen', thumbnailDataUrl: '' }
    ]
    const result = detectMeetingWindow(screenOnly)
    expect(result).toBeNull()
  })

  it('detects Google Meet via "Meet - " title pattern', () => {
    const safari: RecordingSource[] = [
      { id: 'w:10', name: 'Meet - abc-defg-hij', thumbnailDataUrl: '' },
      { id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' }
    ]
    const result = detectMeetingWindow(safari)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:10')
  })

  it('falls back to browser window when no meeting pattern matches', () => {
    const browserOnly: RecordingSource[] = [
      { id: 'w:20', name: 'Safari', thumbnailDataUrl: '' },
      { id: 'w:21', name: 'Visual Studio Code', thumbnailDataUrl: '' },
      { id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' }
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
