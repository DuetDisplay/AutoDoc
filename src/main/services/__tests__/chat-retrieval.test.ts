import { mkdtemp, rm, mkdir, writeFile, utimes } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CalendarEvent,
  MeetingMetadata,
  MeetingSegments,
  Transcript
} from '../../../shared/types'
import {
  ChatRecordingIndex,
  MAX_CHAT_ALL_CONTEXT_MEETINGS,
  type ChatEmbeddingProvider
} from '../chat-retrieval'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('ChatRecordingIndex', () => {
  it('finds the AD-83 visible screen title deterministically', async () => {
    const baseDir = await createTempRecordingsDir()
    const targetStartedAt = new Date(2026, 4, 27, 9, 49).getTime()

    await createQaRecordings(baseDir, targetStartedAt)

    const index = new ChatRecordingIndex(baseDir)
    const result = await index.buildContext('Summarize Entire screen — May 27 at 9:49 AM', [])

    expect(result.directAnswer).toContain('Target recording notes')
    expect(result.diagnostics.matchMode).toBe('exact-title')
    expect(result.diagnostics.selectedMeetingIds).toEqual(['qa-target'])
    expect(result.context).toBe('')
  })

  it('matches custom, calendar, source, and generic aliases', async () => {
    const baseDir = await createTempRecordingsDir()
    const startedAt = new Date(2026, 4, 27, 11, 15).getTime()

    await createRecording(baseDir, 'custom-title', {
      startedAt,
      sourceName: 'Entire screen',
      customTitle: 'QA Custom Title',
      notes: 'Custom title notes'
    })
    await createRecording(baseDir, 'calendar-title', {
      startedAt: startedAt + 60_000,
      sourceName: 'Entire screen',
      calendarTitle: 'Calendar Planning Sync',
      notes: 'Calendar title notes'
    })
    await createRecording(baseDir, 'source-title', {
      startedAt: startedAt + 120_000,
      sourceName: 'Slack Huddle',
      notes: 'Source title notes'
    })
    await createRecording(baseDir, 'generic-title', {
      startedAt: startedAt + 180_000,
      sourceName: 'Entire screen',
      notes: 'Generic title notes'
    })

    const index = new ChatRecordingIndex(baseDir)

    await expectSelected(index, 'Summarize QA Custom Title', 'custom-title')
    await expectSelected(index, 'Summarize Calendar Planning Sync', 'calendar-title')
    await expectSelected(index, 'Summarize Slack Huddle', 'source-title')
    await expectSelected(index, 'Summarize Entire screen — May 27 at 11:18 AM', 'generic-title')
  })

  it('summarizes explicitly selected meeting ids directly for clarification follow-ups', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'selected-huddle', {
      startedAt: new Date(2026, 4, 20, 9, 30).getTime(),
      sourceName: 'Slack Huddle',
      notes: 'Selected huddle notes about QA ownership and beta rollout.'
    })

    const result = await new ChatRecordingIndex(baseDir).buildContextForMeetingIds(
      'second one. Summarize any additional relevant notes from the selected meeting.',
      ['selected-huddle'],
      []
    )

    expect(result.directAnswer).toContain('Selected huddle notes')
    expect(result.context).toBe('')
  })

  it('layers calendar event titles over cached local inventory', async () => {
    const baseDir = await createTempRecordingsDir()
    const startedAt = new Date(2026, 4, 27, 12, 30).getTime()

    await createRecording(baseDir, 'calendar-event-title', {
      startedAt,
      sourceName: 'Entire screen',
      notes: 'Calendar event matched notes'
    })

    const index = new ChatRecordingIndex(baseDir)

    expect(await index.buildExactTitleContext('Summarize Roadmap Review', [])).toBeNull()

    const result = await index.buildContext('Summarize Roadmap Review', [
      {
        id: 'event-1',
        externalId: 'event-1',
        accountId: 'google-account',
        provider: 'google',
        recurringEventId: null,
        title: 'Roadmap Review',
        startTime: startedAt,
        endTime: startedAt + 30 * 60_000,
        attendees: [],
        meetingUrl: null,
        autoRecord: 'off',
        syncedAt: startedAt
      }
    ])

    expect(result.directAnswer).toContain('Calendar event matched notes')
    expect(result.diagnostics.matchMode).toBe('exact-title')
    expect(result.diagnostics.selectedMeetingIds).toEqual(['calendar-event-title'])
  })

  it('answers count and list questions from the full inventory without selected context', async () => {
    const baseDir = await createTempRecordingsDir()
    await createLargeLibrary(baseDir, 100)

    const index = new ChatRecordingIndex(baseDir)
    const count = await index.buildContext('How many recordings do I have?', [])
    const list = await index.buildContext('List my recordings', [])

    expect(count.directAnswer).toBe('You have 100 recordings.')
    expect(count.diagnostics.matchMode).toBe('direct-count')
    expect(count.diagnostics.selectedContextCount).toBe(0)
    expect(list.directAnswer).toContain('I found 100 recordings total')
    expect(list.directAnswer).toContain('showed the most recent 50')
    expect(list.diagnostics.inventoryCount).toBe(100)
  })

  it('summarizes every recording in small libraries and guards large libraries truthfully', async () => {
    const smallDir = await createTempRecordingsDir()
    await createQaRecordings(smallDir, new Date(2026, 4, 27, 9, 49).getTime())
    const small = await new ChatRecordingIndex(smallDir).buildContext(
      'Summarize each of my recordings',
      []
    )

    expect(small.directAnswer).toBeNull()
    expect(small.diagnostics.selectedContextCount).toBe(9)
    expect(small.context).toContain(
      'Recording inventory: 9 total recordings. 9 recordings selected'
    )

    const largeDir = await createTempRecordingsDir()
    await createLargeLibrary(largeDir, MAX_CHAT_ALL_CONTEXT_MEETINGS + 1)
    const large = await new ChatRecordingIndex(largeDir).buildContext(
      'Summarize all of my recordings',
      []
    )

    expect(large.directAnswer).toContain(`I found ${MAX_CHAT_ALL_CONTEXT_MEETINGS + 1} recordings`)
    expect(large.diagnostics.matchMode).toBe('large-all-guardrail')
    expect(large.diagnostics.selectedContextCount).toBe(0)
  })

  it('ranks broad topic questions from notes without loading transcript fallbacks', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'ios-rollout', {
      startedAt: new Date(2026, 4, 25, 9, 0).getTime(),
      sourceName: 'Entire screen',
      notes: 'Pause iOS rollout due to version 3.1.3 crash reports.',
      transcript: 'This transcript should not be needed for broad ranking.'
    })
    await createRecording(baseDir, 'generic-notes', {
      startedAt: new Date(2026, 4, 26, 9, 0).getTime(),
      sourceName: 'Entire screen',
      notes: 'Test meeting notes generation and transcription accuracy.'
    })

    const result = await new ChatRecordingIndex(baseDir).buildContext(
      'What happened with the iOS rollout?',
      []
    )

    expect(result.diagnostics.matchMode).toBe('ranked')
    expect(result.diagnostics.selectedMeetingIds[0]).toBe('ios-rollout')
    expect(result.context).toContain('Pause iOS rollout')
  })

  it('uses structured notes first and transcript excerpts as fallback for matched meetings', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'planning-sync', {
      startedAt: new Date(2026, 4, 27, 9, 30).getTime(),
      sourceName: 'Entire screen',
      calendarTitle: 'Planning Sync',
      notes:
        'The structured notes mention desktop capture, title lookup, and local Ask AI retrieval.',
      transcript:
        'The transcript also mentions a late question about screen sharing permissions and QA follow-up.'
    })

    const result = await new ChatRecordingIndex(baseDir).buildContextForMeetingIds(
      'What was discussed?',
      ['planning-sync']
    )

    expect(result.context).toContain('Use the structured notes first')
    expect(result.context).toContain('desktop capture, title lookup, and local Ask AI retrieval')
    expect(result.context).toContain('### transcriptExcerpt')
    expect(result.context).toContain('screen sharing permissions and QA follow-up')
    expect(result.context.indexOf('### decisions')).toBeLessThan(
      result.context.indexOf('### transcriptExcerpt')
    )
  })

  it('finds transcript-only meetings when notes are missing', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'transcript-only', {
      startedAt: new Date(2026, 4, 27, 14, 0).getTime(),
      sourceName: 'Entire screen',
      notes: null,
      transcript:
        'Jamie said the partner launch checklist is blocked by legal review and needs a Friday decision.'
    })
    await createRecording(baseDir, 'notes-distractor', {
      startedAt: new Date(2026, 4, 27, 15, 0).getTime(),
      sourceName: 'Entire screen',
      notes: 'Routine design review about icons and navigation.'
    })

    const result = await new ChatRecordingIndex(baseDir).buildContext(
      'Which meeting discussed the partner launch checklist?',
      []
    )

    expect(result.diagnostics.selectedMeetingIds).toEqual(['transcript-only'])
    expect(result.context).toContain('partner launch checklist')
    expect(result.context).toContain('Transcript')
    expect(result.context).not.toContain('Routine design review')
  })

  it('keeps this-weeks meeting-content queries inside the current week', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'this-week', {
      startedAt: new Date(2026, 4, 27, 9, 30).getTime(),
      sourceName: 'Entire screen',
      calendarTitle: 'Current Week Sync',
      notes: 'Current week action item: finalize the App Store release notes.'
    })
    await createRecording(baseDir, 'last-week', {
      startedAt: new Date(2026, 4, 20, 9, 30).getTime(),
      sourceName: 'Entire screen',
      calendarTitle: 'Old Week Sync',
      notes: 'Old week action item: investigate the deprecated billing import.'
    })

    const result = await new ChatRecordingIndex(baseDir).buildContext(
      'summarize this weeks meetings action items',
      []
    )

    expect(result.diagnostics.selectedMeetingIds).toEqual(['this-week'])
    expect(result.directAnswer).toContain('App Store release notes')
    expect(result.directAnswer).not.toContain('deprecated billing import')
    expect(result.diagnostics.semanticEnabled).toBe(false)
  })

  it('scopes follow-up content questions to recordings matched from the prior calendar list', async () => {
    const baseDir = await createTempRecordingsDir()
    const standupTime = new Date(2026, 4, 27, 9, 30).getTime()
    const laterTime = new Date(2026, 4, 27, 12, 49).getTime()

    await createRecording(baseDir, 'standup-recording', {
      startedAt: standupTime,
      sourceName: 'Entire screen',
      calendarTitle: 'Duet Display Stand Up',
      segments: createSegmentsFromItems({
        actionItems: [
          {
            title: 'Prepare QA checklist',
            content: 'Prepare the QA checklist for the standup follow-up.',
            topic: 'QA',
            assignee: 'Avery'
          }
        ]
      })
    })
    await createRecording(baseDir, 'later-mock-recording', {
      startedAt: laterTime,
      sourceName: 'MOCK AD-83 Source Window',
      notes: 'Later mock action item that should not be used for the previous calendar list.'
    })

    const calendarEvents = [
      createCalendarEvent('standup-event', 'Duet Display Stand Up', standupTime),
      createCalendarEvent('one-on-one', '1-on-1 with Chris', new Date(2026, 4, 27, 15, 0).getTime())
    ]
    const result = await new ChatRecordingIndex(baseDir).buildContextForCalendarEvents(
      'summarize the action items for me',
      calendarEvents,
      calendarEvents
    )

    expect(result.diagnostics.selectedMeetingIds).toEqual(['standup-recording'])
    expect(result.directAnswer).toContain('Prepare QA checklist')
    expect(result.directAnswer).toContain('Owner: Avery')
    expect(result.directAnswer).not.toContain('Later mock action item')
  })

  it('builds general model evidence for natural meeting-memory questions', async () => {
    const baseDir = await createTempRecordingsDir()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(9, 30, 0, 0)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)

    await createRecording(baseDir, 'standup', {
      startedAt: yesterday.getTime(),
      sourceName: 'Entire screen',
      calendarTitle: 'Daily Standup',
      notes: 'fallback',
      segments: createSegmentsFromItems({
        information: [
          {
            title: 'Billing migration',
            content: 'The team discussed the billing migration risk and rollout sequencing.',
            topic: 'billing migration'
          }
        ],
        actionItems: [
          {
            title: 'Prepare billing checklist',
            content: 'Prepare the billing migration checklist before rollout.',
            topic: 'billing migration',
            assignee: 'Alex',
            deadline: tomorrow.toISOString().slice(0, 10)
          }
        ]
      })
    })
    await createRecording(baseDir, 'unrelated', {
      startedAt: yesterday.getTime() + 60 * 60_000,
      sourceName: 'Entire screen',
      calendarTitle: 'Design Review',
      notes: 'Webflow migration completed, but this is not about billing.'
    })

    const index = new ChatRecordingIndex(baseDir)

    const meeting = await index.buildContext('Which meeting did we discuss billing migration?', [])
    expect(meeting.directAnswer).toBeNull()
    expect(meeting.diagnostics.selectedMeetingIds).toEqual(['standup'])
    expect(meeting.context).toContain('Daily Standup')
    expect(meeting.context).toContain('Billing migration')
    expect(meeting.context).not.toContain('Design Review')

    const assignee = await index.buildContext(
      'Who was assigned to do the billing migration checklist action?',
      []
    )
    expect(assignee.diagnostics.selectedMeetingIds).toEqual(['standup'])
    expect(assignee.directAnswer).toContain('Owner: Alex')
    expect(assignee.directAnswer).toContain('Prepare billing checklist')
    expect(assignee.directAnswer).not.toContain('Manual verification')

    const dueDate = await index.buildContext('What is the due date for billing checklist?', [])
    const [dueYear, dueMonth, dueDay] = tomorrow.toISOString().slice(0, 10).split('-').map(Number)
    expect(dueDate.directAnswer).toContain('Prepare billing checklist')
    expect(dueDate.directAnswer).toContain(
      new Date(dueYear, dueMonth - 1, dueDay).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      })
    )

    const standupCheck = await index.buildContext(
      'In yesterday’s standup did we talk about billing migration?',
      []
    )
    expect(standupCheck.directAnswer).toBeNull()
    expect(standupCheck.diagnostics.selectedMeetingIds).toEqual(['standup'])
    expect(standupCheck.context).toContain('Daily Standup')
    expect(standupCheck.context).toContain('Billing migration')

    const tasks = await index.buildContext('What tasks do I have to complete this week?', [])
    expect(tasks.directAnswer).toContain('Prepare billing checklist')
    expect(tasks.directAnswer).toContain('Owner: Alex')
    expect(tasks.context).toBe('')
  })

  it('keeps last week constrained and treats huddles as standup-like meetings', async () => {
    const baseDir = await createTempRecordingsDir()
    const now = new Date()
    const startOfThisWeek = new Date(now)
    const diffToMonday = startOfThisWeek.getDay() === 0 ? 6 : startOfThisWeek.getDay() - 1
    startOfThisWeek.setDate(startOfThisWeek.getDate() - diffToMonday)
    startOfThisWeek.setHours(0, 0, 0, 0)

    const lastWeekHuddle = new Date(startOfThisWeek)
    lastWeekHuddle.setDate(startOfThisWeek.getDate() - 5)
    lastWeekHuddle.setHours(9, 30, 0, 0)

    const thisWeekHuddle = new Date(startOfThisWeek)
    thisWeekHuddle.setDate(startOfThisWeek.getDate() + 2)
    thisWeekHuddle.setHours(9, 30, 0, 0)

    await createRecording(baseDir, 'last-week-huddle', {
      startedAt: lastWeekHuddle.getTime(),
      sourceName: 'Slack',
      calendarTitle: 'Huddle: #duet-display - Duet Display - Slack',
      notes: 'Discussed the Duet Display beta rollout and QA ownership.'
    })
    await createRecording(baseDir, 'this-week-huddle', {
      startedAt: thisWeekHuddle.getTime(),
      sourceName: 'Slack Huddle',
      notes: 'This week huddle should not be used for last week.'
    })

    const result = await new ChatRecordingIndex(baseDir).buildContext(
      'I think we did a stand up meeting last week. Can you summarize what we talked about in it?',
      []
    )

    expect(result.diagnostics.selectedMeetingIds).toEqual(['last-week-huddle'])
    expect(result.directAnswer).toContain('Huddle: #duet-display - Duet Display - Slack')
    expect(result.directAnswer).toContain('Duet Display beta rollout')
    expect(result.directAnswer).not.toContain('This week huddle should not be used')
    expect(result.context).toBe('')
  })

  it('asks for clarification when vague meeting references match multiple candidates', async () => {
    const baseDir = await createTempRecordingsDir()
    const now = new Date()
    const startOfThisWeek = new Date(now)
    const diffToMonday = startOfThisWeek.getDay() === 0 ? 6 : startOfThisWeek.getDay() - 1
    startOfThisWeek.setDate(startOfThisWeek.getDate() - diffToMonday)
    startOfThisWeek.setHours(0, 0, 0, 0)

    const firstHuddle = new Date(startOfThisWeek)
    firstHuddle.setDate(startOfThisWeek.getDate() - 6)
    firstHuddle.setHours(9, 30, 0, 0)

    const secondHuddle = new Date(startOfThisWeek)
    secondHuddle.setDate(startOfThisWeek.getDate() - 5)
    secondHuddle.setHours(9, 30, 0, 0)

    await createRecording(baseDir, 'first-huddle', {
      startedAt: firstHuddle.getTime(),
      sourceName: 'Slack Huddle',
      notes: 'Discussed QA ownership.'
    })
    await createRecording(baseDir, 'second-huddle', {
      startedAt: secondHuddle.getTime(),
      sourceName: 'Slack Huddle',
      notes: 'Discussed beta rollout.'
    })

    const result = await new ChatRecordingIndex(baseDir).buildContext(
      'Can you summarize the huddle from last week?',
      []
    )

    expect(result.directAnswer).toContain('Which one should I use?')
    expect(result.directAnswer).toContain('Slack Huddle')
    expect(result.diagnostics.selectedMeetingIds).toEqual(['second-huddle', 'first-huddle'])
    expect(result.context).toBe('')
  })

  it('asks for more detail instead of escaping hard constraints when no meeting matches', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'this-week-huddle', {
      startedAt: Date.now(),
      sourceName: 'Slack Huddle',
      notes: 'This should not satisfy last week.'
    })

    const result = await new ChatRecordingIndex(baseDir).buildContext(
      'Can you summarize the standup from last week?',
      []
    )

    expect(result.directAnswer).toContain('could not find a matching local recording')
    expect(result.directAnswer).toContain('date')
    expect(result.diagnostics.selectedMeetingIds).toEqual([])
    expect(result.context).toBe('')
  })

  it('keeps huddle-only clarification options scoped to huddle recordings', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'older-huddle', {
      startedAt: new Date(2026, 4, 20, 9, 30).getTime(),
      sourceName: 'Huddle: #duet-display - Duet Display - Slack',
      notes: 'Discussed Duet Display rollout.'
    })
    await createRecording(baseDir, 'newer-huddle', {
      startedAt: new Date(2026, 4, 27, 7, 49).getTime(),
      sourceName: 'Slack Huddle',
      notes: 'Discussed QA follow-up.'
    })
    await createRecording(baseDir, 'non-huddle', {
      startedAt: new Date(2026, 4, 27, 13, 0).getTime(),
      sourceName: 'Entire screen',
      calendarTitle: 'Engineering Reliability Review',
      notes: 'This non-huddle also mentions huddle in the notes but should not be an option.'
    })

    const result = await new ChatRecordingIndex(baseDir).buildContext(
      'Can you summarize the huddle?',
      []
    )

    expect(result.directAnswer).toContain('Which one should I use?')
    expect(result.directAnswer).toContain('Slack Huddle')
    expect(result.directAnswer).toContain('Huddle: #duet-display')
    expect(result.directAnswer).not.toContain('Engineering Reliability Review')
    expect(result.diagnostics.selectedMeetingIds).toEqual(['newer-huddle', 'older-huddle'])
  })

  it('uses semantic embeddings to retrieve paraphrased meeting questions', async () => {
    const baseDir = await createTempRecordingsDir()
    const startedAt = new Date(2026, 4, 27, 10, 0).getTime()
    await createRecording(baseDir, 'calendar-auth-scope', {
      startedAt,
      sourceName: 'Entire screen',
      calendarTitle: 'Reliability Review',
      segments: createSegmentsFromItems({
        discussion: [
          {
            title: 'OAuth consent scope regression',
            content:
              'Google Calendar sync was blocked because the app token lacked the required readonly event permission.',
            topic: 'calendar integration'
          }
        ],
        actionItems: [
          {
            title: 'Reconnect calendar account',
            content: 'Ask QA to reconnect Google Calendar after the scope migration lands.',
            topic: 'calendar integration',
            assignee: 'Casey'
          }
        ]
      })
    })
    await createRecording(baseDir, 'design-icons', {
      startedAt: startedAt + 60_000,
      sourceName: 'Entire screen',
      calendarTitle: 'Design Review',
      notes: 'Reviewed toolbar icons, sidebar spacing, and visual polish.'
    })

    const index = new ChatRecordingIndex(baseDir, {
      embeddingProvider: new FakeEmbeddingProvider()
    })
    const result = await index.buildContext(
      'Where did we talk about account access failing after sign-in?',
      []
    )

    expect(result.diagnostics.semanticEnabled).toBe(true)
    expect(result.diagnostics.embeddingCacheMisses).toBeGreaterThan(0)
    expect(result.diagnostics.selectedMeetingIds[0]).toBe('calendar-auth-scope')
    expect(result.context).toContain('OAuth consent scope regression')
    expect(result.context).toContain('Owner: Casey')
    expect(result.context).not.toContain('Design Review')
  })

  it('keeps structured broad questions warm over 500 recordings under the target budget', async () => {
    const baseDir = await createTempRecordingsDir()
    await createLargeLibrary(baseDir, 500)
    await createRecording(baseDir, 'broad-target-500', {
      startedAt: new Date().getTime(),
      sourceName: 'Entire screen',
      calendarTitle: 'Growth Sync',
      notes: 'fallback',
      segments: createSegmentsFromItems({
        discussion: [
          {
            title: 'Apollo launch',
            content: 'Discussed the Apollo launch milestones and customer readiness.',
            topic: 'Apollo launch'
          }
        ]
      })
    })

    const index = new ChatRecordingIndex(baseDir)
    await index.buildContext('Which meeting did we discuss Apollo launch?', [])

    const started = performance.now()
    const result = await index.buildContext('Which meeting did we discuss Apollo launch?', [])
    const elapsedMs = performance.now() - started

    expect(result.directAnswer).toBeNull()
    expect(result.context).toContain('Growth Sync')
    expect(result.context).toContain('Apollo launch')
    expect(result.diagnostics.cacheHits).toBeGreaterThan(0)
    expect(elapsedMs).toBeLessThan(50)
  })

  it('keeps exact-title lookup warm over 500 recordings under the target budget', async () => {
    const baseDir = await createTempRecordingsDir()
    const startedAt = new Date(2026, 4, 27, 9, 49).getTime()
    await createLargeLibrary(baseDir, 500)
    await createRecording(baseDir, 'target-500', {
      startedAt,
      sourceName: 'Entire screen',
      notes: 'Large library target notes'
    })

    const index = new ChatRecordingIndex(baseDir)
    await index.buildContext('Summarize Entire screen — May 27 at 9:49 AM', [])

    const started = performance.now()
    const result = await index.buildContext('Summarize Entire screen — May 27 at 9:49 AM', [])
    const elapsedMs = performance.now() - started

    expect(result.diagnostics.selectedMeetingIds).toEqual(['target-500'])
    expect(result.diagnostics.cacheHits).toBeGreaterThanOrEqual(1)
    expect(elapsedMs).toBeLessThan(50)
  })

  it('invalidates cached note summaries when note files change', async () => {
    const baseDir = await createTempRecordingsDir()
    const startedAt = new Date(2026, 4, 27, 9, 49).getTime()
    const meetingDir = await createRecording(baseDir, 'cache-target', {
      startedAt,
      sourceName: 'Entire screen',
      notes: 'Old cache text'
    })
    const index = new ChatRecordingIndex(baseDir)

    expect(
      (await index.buildContext('Summarize Entire screen — May 27 at 9:49 AM', [])).directAnswer
    ).toContain('Old cache text')

    const segmentsPath = join(meetingDir, 'segments.json')
    await writeFile(segmentsPath, JSON.stringify(createSegments('New cache text')))
    const future = new Date(Date.now() + 10_000)
    await utimes(segmentsPath, future, future)

    expect(
      (await index.buildContext('Summarize Entire screen — May 27 at 9:49 AM', [])).directAnswer
    ).toContain('New cache text')
  })
})

async function createTempRecordingsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-chat-retrieval-'))
  tempDirs.push(dir)
  return dir
}

async function expectSelected(
  index: ChatRecordingIndex,
  question: string,
  expectedMeetingId: string
): Promise<void> {
  const result = await index.buildContext(question, [])
  expect(result.diagnostics.matchMode).toBe('exact-title')
  expect(result.diagnostics.selectedMeetingIds).toEqual([expectedMeetingId])
}

function createCalendarEvent(id: string, title: string, startTime: number): CalendarEvent {
  return {
    id,
    externalId: id,
    accountId: 'google-account',
    provider: 'google',
    recurringEventId: null,
    title,
    startTime,
    endTime: startTime + 30 * 60_000,
    attendees: [],
    meetingUrl: null,
    autoRecord: 'off',
    syncedAt: startTime
  }
}

async function createQaRecordings(baseDir: string, targetStartedAt: number): Promise<void> {
  await createRecording(baseDir, 'qa-target', {
    startedAt: targetStartedAt,
    sourceName: 'Entire screen',
    notes: 'Target recording notes for the AD-83 exact title lookup.'
  })

  for (let i = 0; i < 8; i++) {
    await createRecording(baseDir, `qa-${i}`, {
      startedAt: targetStartedAt - (i + 1) * 60 * 60 * 1000,
      sourceName: i % 2 === 0 ? 'Entire screen' : 'Slack Huddle',
      notes: `QA fixture notes ${i}`
    })
  }
}

async function createLargeLibrary(baseDir: string, count: number): Promise<void> {
  const startedAt = new Date(2026, 4, 1, 9, 0).getTime()
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      createRecording(baseDir, `bulk-${i.toString().padStart(4, '0')}`, {
        startedAt: startedAt + i * 60_000,
        sourceName: `Bulk Recording ${i}`,
        notes: `Bulk recording notes ${i} about routine QA and release planning.`
      })
    )
  )
}

async function createRecording(
  baseDir: string,
  id: string,
  params: {
    startedAt: number
    sourceName: string | null
    notes?: string | null
    transcript?: string | null
    customTitle?: string
    calendarTitle?: string
    segments?: MeetingSegments
  }
): Promise<string> {
  const meetingDir = join(baseDir, id)
  await mkdir(meetingDir, { recursive: true })
  await writeFile(join(meetingDir, 'mic.webm'), '')

  const metadata: MeetingMetadata = {
    sourceName: params.sourceName,
    startedAt: params.startedAt,
    stoppedAt: params.startedAt + 30 * 60_000,
    durationSeconds: 30 * 60,
    customTitle: params.customTitle,
    calendarTitle: params.calendarTitle
  }
  await writeFile(join(meetingDir, 'metadata.json'), JSON.stringify(metadata))

  if (params.segments != null || params.notes != null) {
    await writeFile(
      join(meetingDir, 'segments.json'),
      JSON.stringify(params.segments ?? createSegments(params.notes ?? ''))
    )
  }

  if (params.transcript != null) {
    const transcript: Transcript[] = [
      {
        id: `${id}-transcript-1`,
        meetingId: id,
        speaker: 'speaker-1',
        text: params.transcript,
        startMs: 0,
        endMs: 10_000,
        confidence: 0.95
      }
    ]
    await writeFile(join(meetingDir, 'transcript.json'), JSON.stringify(transcript))
  }

  return meetingDir
}

function createSegments(content: string): MeetingSegments {
  return createSegmentsFromItems({
    information: [
      {
        title: 'Fixture note',
        content,
        topic: 'QA'
      }
    ]
  })
}

function createSegmentsFromItems(
  items: Partial<
    Record<
      keyof MeetingSegments,
      Array<{
        title: string
        content: string
        topic?: string | null
        assignee?: string | null
        deadline?: string | null
      }>
    >
  >
): MeetingSegments {
  const segments: MeetingSegments = {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }

  for (const [category, categoryItems] of Object.entries(items) as Array<
    [keyof MeetingSegments, NonNullable<(typeof items)[keyof MeetingSegments]>]
  >) {
    segments[category] = categoryItems.map((item, index) => ({
      id: `${category}-${index}`,
      meetingId: 'fixture',
      category: segmentCategoryForKey(category),
      topic: item.topic ?? null,
      title: item.title,
      content: item.content,
      assignee: item.assignee ?? null,
      deadline: item.deadline ?? null,
      sourceStartMs: index * 10_000,
      sourceEndMs: (index + 1) * 10_000
    }))
  }

  return segments
}

function segmentCategoryForKey(category: keyof MeetingSegments) {
  switch (category) {
    case 'decisions':
      return 'decision'
    case 'actionItems':
      return 'action_item'
    case 'information':
      return 'information'
    case 'discussion':
      return 'discussion'
    case 'statusUpdates':
      return 'status_update'
  }
}

class FakeEmbeddingProvider implements ChatEmbeddingProvider {
  readonly model = 'fake-semantic'

  async isAvailable(): Promise<boolean> {
    return true
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase()
      if (
        normalized.includes('account access') ||
        normalized.includes('oauth consent') ||
        normalized.includes('google calendar sync') ||
        normalized.includes('scope migration')
      ) {
        return [1, 0, 0]
      }
      return [0, 1, 0]
    })
  }
}
