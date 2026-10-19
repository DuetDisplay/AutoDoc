import { describe, it, expect } from 'vitest'
import {
  buildRecordingTrackingContext,
  chooseAutoRecordSource,
  detectMeetingWindow
} from '../window-detection'
import { findActiveCalendarEvent } from '../window-detection'
import { createCalendarEvent } from '../../test/fixtures'
import type { RecordingSource } from '../../../../shared/types'

describe('detectMeetingWindow', () => {
  it('ignores all-day blocks and prefers auto-record over a later timed event', () => {
    const now = Date.now()
    const timed = createCalendarEvent({
      id: 'auto',
      autoRecord: 'once',
      startTime: now - 120_000,
      endTime: now + 60_000
    })
    const later = createCalendarEvent({
      id: 'later',
      autoRecord: 'off',
      startTime: now - 60_000,
      endTime: now + 120_000
    })
    const allDay = { ...timed, id: 'home', isAllDay: true }
    expect(findActiveCalendarEvent([allDay, later, timed], now)?.id).toBe('auto')
    expect(findActiveCalendarEvent([allDay], now)).toBeNull()
    expect(
      findActiveCalendarEvent(
        [timed, later].map((event) => ({ ...event, autoRecord: 'off' })),
        now
      )?.id
    ).toBe('later')
  })
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

  describe('Slack huddle versus main window', () => {
    const slackContext = { eventId: 'e', recurringEventId: null, providerHint: 'slack' }
    const slack = (id: string, name: string): RecordingSource => ({
      id,
      name,
      thumbnailDataUrl: ''
    })

    it('picks the huddle window over the DM window with high confidence', () => {
      const result = chooseAutoRecordSource(
        [
          slack('w:1', 'Walterio - Duet Display - Slack'),
          slack('w:2', 'Walterio (DM) - Duet Display - Slack')
        ],
        slackContext
      )
      expect(result.source?.id).toBe('w:1')
      expect(result.confidence).toBe('high')
      expect(result.bestScore).toBeGreaterThan(result.secondBestScore ?? 0)
    })

    it('demotes any parenthesised view marker, case-insensitively', () => {
      for (const marker of ['(Channel)', '(Private Channel)', '(Group DM)', '(dm)']) {
        const result = chooseAutoRecordSource(
          [slack('w:1', `general ${marker} - Acme - Slack`), slack('w:2', 'Jamal - Acme - Slack')],
          slackContext
        )
        expect(result.source?.id).toBe('w:2')
        expect(result.confidence).toBe('high')
      }
    })

    it('stays ambiguous when both windows are main-window views', () => {
      const result = chooseAutoRecordSource(
        [
          slack('w:1', 'Jamal (DM) - Acme - Slack'),
          slack('w:2', 'general (Channel) - Acme - Slack')
        ],
        slackContext
      )
      expect(result.source).toBeNull()
    })

    it('stays ambiguous for two indistinguishable windows', () => {
      const result = chooseAutoRecordSource(
        [slack('w:1', 'Jamal - Duet Display - Slack'), slack('w:2', 'Jamal - Other - Slack')],
        slackContext
      )
      expect(result.source).toBeNull()
    })

    it('does not treat the Huddles view as a huddle window', () => {
      const result = chooseAutoRecordSource(
        [slack('w:1', 'Huddles - Acme - Slack'), slack('w:2', 'Huddle with Jamal - Acme - Slack')],
        slackContext
      )
      expect(result.source?.id).toBe('w:2')
      expect(result.confidence).toBe('high')
    })

    describe('real Slack titles', () => {
      const MAIN = 'autodoc-social-radar (Channel) - AutoDocTest - Slack'
      const MAIN_HOME = 'autodoc-social-radar (Channel) - AutoDocTest - Slack [Main] 🏠'
      const MAIN_HOME_AUDIO = 'autodoc-social-radar (Channel) - AutoDocTest - Slack [Main] 🏠🔊'
      const MAIN_MARKER_ONLY = 'AutoDocTest - Slack [Main] 🏠'
      const HUDDLE = 'autodoc-social-radar - AutoDocTest - 1 new item - Slack'
      const MAC_PREVIEW = '- AutoDocTest - 1 new item - Slack'
      const WINDOWS_PREVIEW = '- AutodocTest2 - Slack'
      const HUDDLES_VIEW = 'Huddles - AutodocTest2 - Slack'

      it.each([MAIN, MAIN_HOME, MAIN_HOME_AUDIO, MAIN_MARKER_ONLY])(
        'never picks the main window with high confidence when it is alone: %s',
        (title) => {
          const result = chooseAutoRecordSource([slack('w:main', title)], slackContext)
          expect(result.confidence).not.toBe('high')
          expect(result.candidates[0].slackMainWindowName).toBe(true)
          // It is still offered so the picker can suggest it.
          expect(result.source?.id).toBe('w:main')
        }
      )

      it.each([MAC_PREVIEW, WINDOWS_PREVIEW])(
        'never picks the pre-join preview with high confidence: %s',
        (title) => {
          const result = chooseAutoRecordSource([slack('w:preview', title)], slackContext)
          expect(result.confidence).not.toBe('high')
          expect(result.candidates[0].slackPreviewWindowName).toBe(true)
        }
      )

      it.each([
        'Activity - AutoDocTest - Slack',
        'Home - AutoDocTest - Slack',
        'DMs - AutoDocTest - Slack'
      ])('never picks the main window on a sidebar view when it is alone: %s', (title) => {
        const result = chooseAutoRecordSource([slack('w:view', title)], slackContext)
        expect(result.confidence).not.toBe('high')
        expect(result.candidates[0].slackMainWindowName).toBe(true)
      })

      it('picks the huddle over the main window on a sidebar view', () => {
        const result = chooseAutoRecordSource(
          [slack('w:view', 'Activity - AutoDocTest - Slack'), slack('w:huddle', HUDDLE)],
          slackContext
        )
        expect(result.source?.id).toBe('w:huddle')
        expect(result.confidence).toBe('high')
      })

      it('treats the Huddles view as a main window, not a huddle', () => {
        const result = chooseAutoRecordSource([slack('w:view', HUDDLES_VIEW)], slackContext)
        expect(result.confidence).not.toBe('high')
        expect(result.candidates[0]).toMatchObject({
          slackHuddleName: false,
          slackMainWindowName: true
        })
      })

      it.each([MAIN, MAIN_HOME, MAIN_HOME_AUDIO])(
        'picks the huddle window over the main window with high confidence: %s',
        (title) => {
          const result = chooseAutoRecordSource(
            [slack('w:main', title), slack('w:huddle', HUDDLE)],
            slackContext
          )
          expect(result.source?.id).toBe('w:huddle')
          expect(result.confidence).toBe('high')
        }
      )

      it.each([
        [MAC_PREVIEW, MAIN_HOME],
        [WINDOWS_PREVIEW, HUDDLES_VIEW]
      ])('lets neither the preview nor the main window win: %s + %s', (preview, main) => {
        const result = chooseAutoRecordSource(
          [slack('w:preview', preview), slack('w:main', main)],
          slackContext
        )
        expect(result.confidence).not.toBe('high')
      })

      it('picks the huddle window over the pre-join preview', () => {
        const result = chooseAutoRecordSource(
          [slack('w:preview', MAC_PREVIEW), slack('w:huddle', HUDDLE)],
          slackContext
        )
        expect(result.source?.id).toBe('w:huddle')
        expect(result.confidence).toBe('high')
      })

      it('ignores a remembered main or preview window so it cannot outrank the huddle', () => {
        const preference = {
          sourceId: 'w:main',
          sourceName: MAIN,
          updatedAt: 0
        } as never
        const result = chooseAutoRecordSource(
          [slack('w:main', MAIN_HOME), slack('w:huddle', HUDDLE)],
          slackContext,
          preference
        )
        expect(result.source?.id).toBe('w:huddle')
        expect(result.confidence).toBe('high')
        expect(result.candidates.some((c) => c.rememberedSource)).toBe(false)

        const alone = chooseAutoRecordSource([slack('w:main', MAIN)], slackContext, preference)
        expect(alone.confidence).not.toBe('high')
        expect(alone.method).not.toBe('remembered_source')
      })

      it('still honours a remembered huddle window', () => {
        const result = chooseAutoRecordSource(
          [slack('w:huddle', HUDDLE), slack('w:huddle2', 'other-channel - AutoDocTest - Slack')],
          slackContext,
          { sourceId: 'w:huddle2', sourceName: 'x', updatedAt: 0 } as never
        )
        expect(result.source?.id).toBe('w:huddle2')
        expect(result.candidates.find((c) => c.rememberedSource)).toBeDefined()
      })
    })

    it('does not penalise other providers', () => {
      const result = chooseAutoRecordSource(
        [
          { id: 'w:1', name: 'Zoom Meeting (Sprint)', thumbnailDataUrl: '' },
          { id: 'w:2', name: 'Visual Studio Code', thumbnailDataUrl: '' }
        ],
        { eventId: null, recurringEventId: null, providerHint: 'zoom' }
      )
      expect(result.source?.id).toBe('w:1')
      expect(result.bestScore).toBe(160)
    })
  })
})

describe('chooseAutoRecordSource diagnostics', () => {
  const slackSources: RecordingSource[] = [
    { id: 'window:huddle', name: 'Huddle: Product – Slack', thumbnailDataUrl: '' },
    { id: 'window:dm', name: 'Jamal (DM) - Duet Display - Slack', thumbnailDataUrl: '' },
    { id: 'window:chrome', name: 'Testing Autodoc - Google Chrome', thumbnailDataUrl: '' },
    { id: 'window:code', name: 'Visual Studio Code', thumbnailDataUrl: '' },
    { id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' }
  ]
  const context = { eventId: 'evt', recurringEventId: null, providerHint: 'slack' }

  it('exposes per-window features that add up to the score, without window names', () => {
    const selection = chooseAutoRecordSource(slackSources, context)
    expect(selection.chosenIndex).toBe(0)
    expect(selection.candidateSourceIds[0]).toBe('window:huddle')
    expect(selection.candidates).toHaveLength(4)
    for (const candidate of selection.candidates) {
      const expected =
        (candidate.slackHuddleName ? 110 : 0) +
        (candidate.providerHintMatch ? 90 : 0) +
        (candidate.meetingPattern ? 70 : 0) -
        (candidate.slackMainWindowName ? 60 : 0) -
        (candidate.slackPreviewWindowName ? 60 : 0) +
        (candidate.browser ? 20 : 0) +
        (candidate.rememberedSource ? 150 : 0)
      expect(candidate.score).toBe(expected)
      expect(candidate.sourceType).toBe('window')
    }
    expect(selection.candidates[0]).toMatchObject({
      slackHuddleName: true,
      slackMainWindowName: false,
      providerHintMatch: true
    })
    expect(
      selection.candidates.find((c, i) => selection.candidateSourceIds[i] === 'window:dm')
    ).toMatchObject({ slackMainWindowName: true, providerHintMatch: true })
    expect(selection.candidates[0].score).toBe(selection.bestScore)
    const logged = JSON.stringify(selection.candidates)
    expect(logged).not.toContain('Jamal')
    expect(logged).not.toContain('Testing Autodoc')
  })

  it('flags a remembered source and leaves chosenIndex null for a tie', () => {
    const remembered = chooseAutoRecordSource(slackSources, context, {
      sourceId: 'window:code',
      sourceName: 'Visual Studio Code',
      updatedAt: 0
    } as never)
    expect(remembered.candidates.filter((c) => c.rememberedSource)).toHaveLength(1)
    expect(remembered.candidates.find((c) => c.rememberedSource)?.method).toBe('remembered_source')

    const tie = chooseAutoRecordSource(
      [
        { id: 'window:1', name: 'Jamal - Duet Display - Slack', thumbnailDataUrl: '' },
        { id: 'window:2', name: 'Jamal - Other Workspace - Slack', thumbnailDataUrl: '' }
      ],
      context
    )
    expect(tie.source).toBeNull()
    expect(tie.chosenIndex).toBeNull()
    expect(tie.candidates.map((c) => c.score)).toEqual([160, 160])
  })

  it('limits diagnostics to the top six windows', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      id: `window:${index}`,
      name: `Zoom Meeting ${index}`,
      thumbnailDataUrl: ''
    }))
    const selection = chooseAutoRecordSource(many, { ...context, providerHint: 'zoom' })
    expect(selection.candidates).toHaveLength(6)
    expect(selection.candidateSourceIds).toHaveLength(6)
    expect(selection.windowCount).toBe(9)
  })
})
