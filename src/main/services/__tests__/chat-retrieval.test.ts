import { mkdtemp, rm, mkdir, writeFile, utimes } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CalendarEvent,
  MeetingMetadata,
  MeetingSegments,
  Transcript
} from '../../../shared/types'
import {
  ChatRecordingIndex,
  MAX_CHAT_ALL_CONTEXT_MEETINGS,
  detectChatIntent,
  isLatestRecordingQuery,
  isOldestRecordingQuery,
  isRecordingCollectionTemporalQuestion,
  type ChatEmbeddingProvider
} from '../chat-retrieval'

const tempDirs: string[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 4, 27, 12, 0))
})

afterEach(async () => {
  vi.useRealTimers()
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

  it('counts a just-finished recording immediately, without waiting out the inventory TTL (AD-83)', async () => {
    const baseDir = await createTempRecordingsDir()
    const base = new Date(2026, 4, 27, 9, 0).getTime()
    await createRecording(baseDir, 'rec-1', {
      startedAt: base,
      sourceName: 'Entire screen',
      notes: 'first recording'
    })
    // No watcher: the only freshness mechanism is the forced scan on count/list.
    const index = new ChatRecordingIndex(baseDir)

    const first = await index.buildContext('how many recordings do I have?', [])
    expect(first.directAnswer).toContain('1 recording')

    // A second recording lands. The fs watcher is off and we do NOT advance the
    // clock past the 60s TTL, reproducing QA's "took three attempts" staleness.
    await createRecording(baseDir, 'rec-2', {
      startedAt: base + 60_000,
      sourceName: 'Slack Huddle',
      notes: 'second recording'
    })

    const second = await index.buildContext('how many recordings do I have?', [])
    expect(second.directAnswer).toContain('2 recordings')
    expect(await index.listInventory()).toHaveLength(2)
  })

  it('finds a just-finished recording by title within the TTL window (AD-83)', async () => {
    const baseDir = await createTempRecordingsDir()
    const base = new Date(2026, 4, 27, 9, 0).getTime()
    await createRecording(baseDir, 'rec-1', {
      startedAt: base,
      sourceName: 'Entire screen',
      notes: 'first recording'
    })
    const index = new ChatRecordingIndex(baseDir)
    // Warm the inventory cache, then add a recording without advancing the clock.
    await index.buildContext('how many recordings do I have?', [])

    await createRecording(baseDir, 'standup', {
      startedAt: base + 60_000,
      sourceName: 'Entire screen',
      customTitle: 'Daily Standup Notes',
      notes: 'standup notes'
    })

    const result = await index.buildExactTitleContext('Summarize Daily Standup Notes')
    expect(result?.diagnostics.matchMode).toBe('exact-title')
    expect(result?.diagnostics.selectedMeetingIds).toEqual(['standup'])
  })

  it('answers a generic follow-up question from meetings that have action items (AD-83 action-items)', async () => {
    const baseDir = await createTempRecordingsDir()
    const base = new Date(2026, 4, 27, 9, 0).getTime()
    await createRecording(baseDir, 'roadmap', {
      startedAt: base + 7_200_000,
      sourceName: 'Roadmap Review',
      notes: 'Q3 roadmap sequencing was locked.'
    })
    await createRecording(baseDir, 'support', {
      startedAt: base,
      sourceName: 'Support Triage',
      segments: createSegmentsFromItems({
        actionItems: [
          {
            title: 'Escalation follow-up',
            content: 'Casey owns the escalation follow-up for the priority customer queue.',
            topic: 'Support',
            assignee: 'Casey'
          }
        ]
      })
    })

    const index = new ChatRecordingIndex(baseDir)
    const result = await index.buildContext('what do I need to follow up on?', [])
    const answer = result.directAnswer ?? result.context
    expect(answer).toContain('Casey')
    expect(answer).not.toContain('did not find')
  })

  it('selects the newest recording for a "most recent recording" question (AD-83 recall)', async () => {
    const baseDir = await createTempRecordingsDir()
    const base = new Date(2026, 4, 27, 9, 0).getTime()
    await createRecording(baseDir, 'older', {
      startedAt: base,
      sourceName: 'Roadmap Review',
      notes: 'Q3 roadmap sequencing was locked.'
    })
    await createRecording(baseDir, 'newer', {
      startedAt: base + 3_600_000,
      sourceName: 'Design Sync',
      notes: 'The team rewrote the onboarding copy.'
    })

    const index = new ChatRecordingIndex(baseDir)
    const result = await index.buildContext('what was my most recent recording about?', [])
    expect(result.diagnostics.selectedMeetingIds).toEqual(['newer'])
    expect(result.context).toContain('onboarding')
  })

  it('treats a time window ("last week") as a filter, not a most-recent selector', () => {
    expect(isLatestRecordingQuery('what was my most recent recording about?')).toBe(true)
    expect(isLatestRecordingQuery('my latest recording')).toBe(true)
    expect(isLatestRecordingQuery('summarize my recordings from last week')).toBe(false)
    expect(isLatestRecordingQuery('what did we discuss in the roadmap review?')).toBe(false)
  })

  it('selects the oldest recording for an "oldest recording" question', async () => {
    const baseDir = await createTempRecordingsDir()
    const base = new Date(2026, 4, 27, 9, 0).getTime()
    await createRecording(baseDir, 'older', {
      startedAt: base,
      sourceName: 'Roadmap Review',
      notes: 'Q3 roadmap sequencing was locked.'
    })
    await createRecording(baseDir, 'newer', {
      startedAt: base + 3_600_000,
      sourceName: 'Design Sync',
      notes: 'The team rewrote the onboarding copy.'
    })

    const index = new ChatRecordingIndex(baseDir)
    const result = await index.buildContext('what is the oldest recording I have?', [])
    expect(result.diagnostics.selectedMeetingIds).toEqual(['older'])
    expect(result.context).toContain('roadmap')
  })

  it('detects oldest/first ordering without treating time windows as selectors', () => {
    expect(isOldestRecordingQuery('what is the oldest recording I have?')).toBe(true)
    expect(isOldestRecordingQuery('my very first recording')).toBe(true)
    expect(isOldestRecordingQuery('the earliest recording')).toBe(true)
    expect(isOldestRecordingQuery('recordings from last month')).toBe(false)
    expect(isOldestRecordingQuery('what did we discuss in the roadmap review?')).toBe(false)
  })

  it('routes "main topics across my recordings" to synthesis, not an empty list', async () => {
    const baseDir = await createTempRecordingsDir()
    const base = new Date(2026, 4, 27, 9, 0).getTime()
    await createRecording(baseDir, 'roadmap', {
      startedAt: base,
      sourceName: 'Roadmap Review',
      notes: 'Q3 roadmap sequencing was locked.'
    })
    await createRecording(baseDir, 'support', {
      startedAt: base + 3_600_000,
      sourceName: 'Support Triage',
      notes: 'Casey owns the escalation follow-up due Friday.'
    })

    expect(detectChatIntent('what are the main topics across my recordings?')).toBe('summarize-all')
    const index = new ChatRecordingIndex(baseDir)
    const result = await index.buildContext('what are the main topics across my recordings?', [])
    const answer = result.directAnswer ?? result.context
    expect(answer).not.toContain('do not have any recordings')
    expect(answer.toLowerCase()).toMatch(/roadmap|support|escalation|casey/)
  })

  it('answers a comparison question with both named meetings in context', async () => {
    const baseDir = await createTempRecordingsDir()
    const base = new Date(2026, 4, 27, 9, 0).getTime()
    await createRecording(baseDir, 'roadmap', {
      startedAt: base + 3_600_000,
      sourceName: 'Roadmap Review',
      notes: 'Q3 roadmap sequencing was locked. Priya drives the milestone tracker.'
    })
    await createRecording(baseDir, 'support', {
      startedAt: base,
      sourceName: 'Support Triage',
      notes: 'Casey owns the escalation follow-up for the priority customer queue.'
    })

    const index = new ChatRecordingIndex(baseDir)
    const result = await index.buildContext('compare the roadmap and support meetings', [])
    const answer = (result.directAnswer ?? result.context).toLowerCase()
    expect(answer).toMatch(/roadmap|priya|q3/)
    expect(answer).toMatch(/support|casey|escalation/)
  })

  it('answers a collection-timing question with the dated inventory list', async () => {
    const baseDir = await createTempRecordingsDir()
    const base = new Date(2026, 4, 27, 9, 0).getTime()
    await createRecording(baseDir, 'a', {
      startedAt: base,
      sourceName: 'Roadmap Review',
      notes: 'x'
    })
    await createRecording(baseDir, 'b', {
      startedAt: base + 3_600_000,
      sourceName: 'Design Sync',
      notes: 'y'
    })

    expect(isRecordingCollectionTemporalQuestion('were these all recorded on the same day?')).toBe(
      true
    )
    expect(isRecordingCollectionTemporalQuestion('what did we discuss in these recordings?')).toBe(
      false
    )

    const index = new ChatRecordingIndex(baseDir)
    const result = await index.buildContext('were these all recorded on the same day?', [])
    const answer = result.directAnswer ?? result.context
    expect(answer).not.toContain('calendar')
    expect(answer.toLowerCase()).toMatch(/roadmap|design|recordings?/)
  })

  it('surfaces action items for a generic "follow-up I\'m forgetting" question', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'support', {
      startedAt: new Date(2026, 4, 27, 9, 0).getTime(),
      sourceName: 'Support Triage',
      notes: 'Action item: Casey to follow up on the escalation for the priority customer queue.'
    })

    const index = new ChatRecordingIndex(baseDir)
    const result = await index.buildContext("is there a follow-up I'm forgetting?", [])
    const answer = (result.directAnswer ?? result.context).toLowerCase()
    expect(answer).not.toContain('did not find')
    expect(answer).toMatch(/casey|escalation|follow/)
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
    expect(count.diagnostics.matchedMeetingIds).toHaveLength(100)
    expect(list.directAnswer).toContain('I found 100 recordings total')
    expect(list.directAnswer).toContain('showed the most recent 50')
    expect(list.diagnostics.inventoryCount).toBe(100)
    expect(list.diagnostics.selectedContextCount).toBe(0)
    expect(list.diagnostics.matchedMeetingIds).toHaveLength(100)
  })

  it('applies direct count and list qualifiers before answering', async () => {
    const baseDir = await createTempRecordingsDir()
    const startedAt = new Date(2026, 4, 27, 9, 0).getTime()
    await createRecording(baseDir, 'standup', {
      startedAt,
      sourceName: 'Engineering Standup',
      notes: 'Standup notes about release readiness.'
    })
    await createRecording(baseDir, 'billing', {
      startedAt: startedAt + 60_000,
      sourceName: 'Billing Review',
      notes: 'Billing migration checklist and customer invoice follow-up.'
    })

    const index = new ChatRecordingIndex(baseDir)
    const count = await index.buildContext('How many billing recordings do I have?', [])
    const list = await index.buildContext('List my standup recordings', [])

    expect(count.directAnswer).toBe('You have 1 recording.')
    expect(count.diagnostics.matchedCount).toBe(1)
    expect(list.directAnswer).toContain('Engineering Standup')
    expect(list.directAnswer).not.toContain('Billing Review')
  })

  it('summarizes every recording in small libraries and guards large libraries truthfully', async () => {
    const smallDir = await createTempRecordingsDir()
    await createQaRecordings(smallDir, new Date(2026, 4, 27, 9, 49).getTime())
    const small = await new ChatRecordingIndex(smallDir).buildContext(
      'Summarize each of my recordings',
      []
    )

    expect(small.directAnswer).toContain('I found 9 relevant notes across 9 meetings')
    expect(small.directAnswer).toContain('Target recording notes')
    expect(small.diagnostics.selectedContextCount).toBe(9)
    expect(small.context).toBe('')

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

  it('persists semantic meeting embeddings across index restarts', async () => {
    const baseDir = await createTempRecordingsDir()
    const cachePath = join(baseDir, 'cache', 'semantic-embeddings.json')
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
        ]
      })
    })
    await createRecording(baseDir, 'design-icons', {
      startedAt: startedAt + 60_000,
      sourceName: 'Entire screen',
      calendarTitle: 'Design Review',
      notes: 'Reviewed toolbar icons, sidebar spacing, and visual polish.'
    })

    const firstProvider = new FakeEmbeddingProvider()
    const first = await new ChatRecordingIndex(baseDir, {
      embeddingProvider: firstProvider,
      embeddingCachePath: cachePath
    }).buildContext('Where did we talk about account access failing after sign-in?', [])

    const secondProvider = new FakeEmbeddingProvider()
    const second = await new ChatRecordingIndex(baseDir, {
      embeddingProvider: secondProvider,
      embeddingCachePath: cachePath
    }).buildContext('Where did we talk about account access failing after sign-in?', [])

    expect(first.diagnostics.embeddingCacheMisses).toBeGreaterThan(0)
    expect(second.diagnostics.embeddingCacheHits).toBeGreaterThan(0)
    expect(second.diagnostics.embeddingCacheMisses).toBe(0)
    expect(second.diagnostics.selectedMeetingIds[0]).toBe('calendar-auth-scope')
    expect(secondProvider.embedCalls).toEqual([])
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

  it('evaluates natural broad questions across topics, ambiguity, and no-match cases', async () => {
    const baseDir = await createTempRecordingsDir()
    await createEvaluationCorpus(baseDir)
    const index = new ChatRecordingIndex(baseDir, {
      embeddingProvider: new FakeEmbeddingProvider()
    })

    const cases: Array<{
      question: string
      expectedIds?: string[]
      directAnswerIncludes?: string
      clarification?: boolean
      noMatch?: boolean
    }> = [
      ...[
        'Which meeting covered Google Calendar scope failures?',
        'Where did we discuss account access failing after sign-in?',
        'Which call talked about OAuth consent permissions?',
        'Find the meeting about reconnecting calendar accounts',
        'What meeting mentioned readonly event permission?',
        'Where was Google Calendar reconnect discussed?'
      ].map((question) => ({ question, expectedIds: ['eval-calendar-auth'] })),
      ...[
        'Who owns the beta launch checklist?',
        'What is due for the launch plan?',
        'Which meeting talked about June beta scope?',
        'Where did we decide to limit the beta?',
        'What tasks came out of the launch planning meeting?',
        'Which notes mention customer-facing checklist work?'
      ].map((question) => ({ question, expectedIds: ['eval-product-launch'] })),
      ...[
        'Which meeting covered toolbar icon polish?',
        'Where did we discuss sidebar spacing?',
        'What meeting reviewed visual polish?',
        'Find notes about the command palette icon set',
        'Which design review mentioned compact navigation?',
        'Where did we decide to reduce sidebar spacing?'
      ].map((question) => ({ question, expectedIds: ['eval-design-review'] })),
      ...[
        'Who was assigned the offline mode QA matrix?',
        'What is the due date for offline QA?',
        'Which standup mentioned the offline queue?',
        'Where did we discuss flaky offline uploads?',
        'What tasks do I have around offline mode?',
        'Which meeting reproduced flaky upload coverage?'
      ].map((question) => ({ question, expectedIds: ['eval-offline-standup'] })),
      ...[
        'Which meeting discussed enterprise onboarding blockers?',
        'Who owns the SSO migration checklist?',
        'When is the SSO migration checklist due?',
        'Where did we talk about SAML setup?',
        'What customer onboarding actions are open?',
        'Which meeting had enterprise admin setup steps?'
      ].map((question) => ({ question, expectedIds: ['eval-enterprise-sync'] })),
      ...[
        'What meetings mentioned customer trust?',
        'Where did we discuss hallucinated action items?',
        'Which meeting covered answer citations?',
        'What was decided about evidence-first answers?',
        'Find the reliability meeting about grounded notes',
        'Where did we say answers should use local notes first?'
      ].map((question) => ({ question, expectedIds: ['eval-reliability-review'] })),
      ...[
        'Which huddle should I use?',
        'Can you summarize the huddle?',
        'What did we talk about in the sync?',
        'I cannot remember the huddle, which one was it?',
        'Which meeting was that?',
        'Can you find that meeting for me?'
      ].map((question) => ({ question, clarification: true })),
      {
        question: 'I cannot remember the standup, which one was it?',
        expectedIds: ['eval-offline-standup']
      },
      ...[
        'Were there any meetings about hotdogs?',
        'Find the meeting about submarine procurement',
        'Who owns the lunar greenhouse task?',
        'What was the deadline for the salsa festival?',
        'Which meeting discussed medieval tax policy?'
      ].map((question) => ({ question, noMatch: true })),
      {
        question: 'Summarize what we discussed across this week’s meetings',
        expectedIds: ['eval-calendar-auth', 'eval-product-launch'],
        directAnswerIncludes: 'I found'
      },
      {
        question: 'Compare the decisions from this week’s meetings',
        expectedIds: ['eval-calendar-auth', 'eval-product-launch'],
        directAnswerIncludes: 'From'
      },
      {
        question: 'What action items came out of all meetings this week?',
        expectedIds: ['eval-calendar-auth', 'eval-product-launch'],
        directAnswerIncludes: 'action item'
      },
      {
        question: 'What did meetings this week say about reliability?',
        expectedIds: ['eval-reliability-review'],
        directAnswerIncludes: 'Grounded notes'
      },
      {
        question: 'Which meeting had Slack channel #duet-display?',
        expectedIds: ['eval-slack-huddle']
      }
    ]

    expect(cases.length).toBeGreaterThanOrEqual(50)

    for (const testCase of cases) {
      const result = await index.buildContext(testCase.question, createEvaluationCalendarEvents())

      if (testCase.clarification) {
        if (typeof result.directAnswer !== 'string') {
          throw new Error(
            `${testCase.question}: expected clarification string, got ${JSON.stringify(
              result.directAnswer
            )}; diagnostics ${JSON.stringify(result.diagnostics)}`
          )
        }
        expect(result.directAnswer, testCase.question).toMatch(/which one should i use/i)
        expect(result.clarificationOptions?.length, testCase.question).toBeGreaterThan(1)
        expect(result.diagnostics.clarificationReason, testCase.question).not.toBe('none')
        continue
      }

      if (testCase.noMatch) {
        expect(result.directAnswer ?? result.context, testCase.question).toMatch(
          /could not find|did not find|no matching meeting data/i
        )
        continue
      }

      for (const expectedId of testCase.expectedIds ?? []) {
        expect(result.diagnostics.selectedMeetingIds, testCase.question).toContain(expectedId)
      }
      if (testCase.directAnswerIncludes) {
        expect(result.directAnswer ?? result.context, testCase.question).toContain(
          testCase.directAnswerIncludes
        )
      }
      expect(result.diagnostics.promptChars, testCase.question).toBeLessThan(14_000)
    }
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

async function createEvaluationCorpus(baseDir: string): Promise<void> {
  const thisWeekTuesday = new Date(2026, 4, 26, 9, 30).getTime()
  const thisWeekWednesday = new Date(2026, 4, 27, 10, 30).getTime()
  const thisWeekThursday = new Date(2026, 4, 28, 11, 0).getTime()
  const lastWeekTuesday = new Date(2026, 4, 19, 9, 30).getTime()
  const lastWeekWednesday = new Date(2026, 4, 20, 9, 30).getTime()

  await createRecording(baseDir, 'eval-calendar-auth', {
    startedAt: thisWeekTuesday,
    sourceName: 'Entire screen',
    calendarTitle: 'Calendar Reliability Review',
    speakers: {
      'speaker-1': { label: 'Avery' },
      'speaker-2': { label: 'Casey' }
    },
    segments: createSegmentsFromItems({
      discussion: [
        {
          title: 'Google Calendar scope failures',
          content:
            'Google Calendar sync failed after sign-in because account access tokens were missing readonly event permission.',
          topic: 'calendar integration'
        },
        {
          title: 'OAuth consent permissions',
          content:
            'The team reviewed OAuth consent and decided QA should reconnect calendar accounts after the scope migration.',
          topic: 'calendar integration'
        }
      ],
      actionItems: [
        {
          title: 'Reconnect calendar accounts',
          content: 'Ask QA to reconnect Google Calendar after the scope migration lands.',
          topic: 'calendar integration',
          assignee: 'Casey',
          deadline: '2026-05-29'
        }
      ]
    })
  })

  await createRecording(baseDir, 'eval-product-launch', {
    startedAt: thisWeekWednesday,
    sourceName: 'Entire screen',
    calendarTitle: 'Launch Planning',
    speakers: {
      'speaker-1': { label: 'Morgan' },
      'speaker-2': { label: 'Taylor' }
    },
    segments: createSegmentsFromItems({
      decisions: [
        {
          title: 'Limit June beta scope',
          content:
            'The June beta will focus on workspace notes, import stability, and admin setup.',
          topic: 'June beta scope'
        }
      ],
      actionItems: [
        {
          title: 'Beta launch checklist',
          content: 'Build the launch plan and customer-facing checklist for the June beta.',
          topic: 'June beta scope',
          assignee: 'Morgan',
          deadline: '2026-06-03'
        }
      ]
    })
  })

  await createRecording(baseDir, 'eval-design-review', {
    startedAt: lastWeekTuesday,
    sourceName: 'Figma',
    calendarTitle: 'Design Review',
    segments: createSegmentsFromItems({
      discussion: [
        {
          title: 'Toolbar icon polish',
          content:
            'Reviewed command palette icon set, sidebar spacing, compact navigation, and visual polish.',
          topic: 'toolbar icons'
        }
      ],
      decisions: [
        {
          title: 'Compact navigation',
          content: 'Keep the compact navigation treatment and reduce sidebar spacing.',
          topic: 'navigation'
        }
      ]
    })
  })

  await createRecording(baseDir, 'eval-offline-standup', {
    startedAt: lastWeekWednesday,
    sourceName: 'Entire screen',
    calendarTitle: 'Daily Standup',
    segments: createSegmentsFromItems({
      statusUpdates: [
        {
          title: 'Offline queue status',
          content: 'Flaky offline uploads were reproduced in the offline queue.',
          topic: 'offline mode'
        }
      ],
      actionItems: [
        {
          title: 'Offline mode QA matrix',
          content: 'Complete the offline mode QA matrix for flaky upload coverage.',
          topic: 'offline mode',
          assignee: 'Riley',
          deadline: '2026-05-23'
        }
      ]
    })
  })

  await createRecording(baseDir, 'eval-enterprise-sync', {
    startedAt: new Date(2026, 4, 18, 14, 0).getTime(),
    sourceName: 'Zoom',
    calendarTitle: 'Enterprise Onboarding Sync',
    segments: createSegmentsFromItems({
      discussion: [
        {
          title: 'Enterprise onboarding blockers',
          content: 'Customer onboarding is blocked by SAML setup and SSO migration coordination.',
          topic: 'enterprise onboarding'
        }
      ],
      actionItems: [
        {
          title: 'SSO migration checklist',
          content:
            'Prepare enterprise admin setup steps, SAML setup steps, and the SSO migration checklist.',
          topic: 'enterprise onboarding',
          assignee: 'Jordan',
          deadline: '2026-05-22'
        }
      ]
    })
  })

  await createRecording(baseDir, 'eval-reliability-review', {
    startedAt: thisWeekThursday,
    sourceName: 'Entire screen',
    calendarTitle: 'Answer Reliability Review',
    segments: createSegmentsFromItems({
      discussion: [
        {
          title: 'Grounded notes',
          content:
            'The team discussed customer trust, answer citations, and preventing hallucinated action items.',
          topic: 'answer reliability'
        }
      ],
      decisions: [
        {
          title: 'Evidence-first answers',
          content: 'Answers should be grounded in local notes before transcript excerpts.',
          topic: 'answer reliability'
        }
      ]
    })
  })

  await createRecording(baseDir, 'eval-slack-huddle', {
    startedAt: lastWeekWednesday + 60 * 60_000,
    sourceName: 'Huddle: #duet-display - Duet Display - Slack',
    transcript:
      'We talked about beta rollout follow-up in the duet-display channel and checked QA ownership.',
    speakers: {
      'speaker-1': { label: 'Chris' },
      'speaker-2': { label: 'Sam' }
    }
  })

  await createRecording(baseDir, 'eval-second-huddle', {
    startedAt: lastWeekWednesday + 2 * 60 * 60_000,
    sourceName: 'Slack Huddle',
    notes: 'A second huddle covered analytics cleanup and support triage.'
  })

  await createRecording(baseDir, 'eval-customer-sync', {
    startedAt: new Date(2026, 4, 21, 12, 0).getTime(),
    sourceName: 'Entire screen',
    calendarTitle: 'Customer Sync',
    notes: 'Reviewed renewal sentiment and customer feedback about exports.'
  })
}

function createEvaluationCalendarEvents(): CalendarEvent[] {
  return [
    {
      ...createCalendarEvent(
        'eval-calendar-auth-event',
        'Calendar Reliability Review',
        new Date(2026, 4, 26, 9, 30).getTime()
      ),
      attendees: ['avery@example.com', 'casey@example.com']
    },
    {
      ...createCalendarEvent(
        'eval-product-launch-event',
        'Launch Planning',
        new Date(2026, 4, 27, 10, 30).getTime()
      ),
      attendees: ['morgan@example.com', 'taylor@example.com']
    },
    {
      ...createCalendarEvent(
        'eval-reliability-event',
        'Answer Reliability Review',
        new Date(2026, 4, 28, 11, 0).getTime()
      ),
      attendees: ['qa@example.com', 'product@example.com']
    }
  ]
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
    speakers?: Record<string, { label: string }>
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

  if (params.speakers != null) {
    await writeFile(join(meetingDir, 'speakers.json'), JSON.stringify(params.speakers))
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

function segmentCategoryForKey(
  category: keyof MeetingSegments
): 'decision' | 'action_item' | 'information' | 'discussion' | 'status_update' {
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
  readonly embedCalls: string[][] = []

  async isAvailable(): Promise<boolean> {
    return true
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls.push(texts)
    return texts.map((text) => {
      const normalized = text.toLowerCase()
      if (
        normalized.includes('account access') ||
        normalized.includes('oauth consent') ||
        normalized.includes('google calendar') ||
        normalized.includes('google calendar sync') ||
        normalized.includes('readonly event permission') ||
        normalized.includes('calendar accounts') ||
        normalized.includes('scope migration')
      ) {
        return [1, 0, 0, 0, 0, 0, 0]
      }
      if (
        normalized.includes('beta launch') ||
        normalized.includes('launch plan') ||
        normalized.includes('june beta') ||
        normalized.includes('customer-facing checklist') ||
        normalized.includes('limit the beta')
      ) {
        return [0, 1, 0, 0, 0, 0, 0]
      }
      if (
        normalized.includes('toolbar') ||
        normalized.includes('sidebar') ||
        normalized.includes('visual polish') ||
        normalized.includes('command palette') ||
        normalized.includes('compact navigation')
      ) {
        return [0, 0, 1, 0, 0, 0, 0]
      }
      if (
        normalized.includes('offline') ||
        normalized.includes('flaky upload') ||
        normalized.includes('offline queue')
      ) {
        return [0, 0, 0, 1, 0, 0, 0]
      }
      if (
        normalized.includes('enterprise') ||
        normalized.includes('sso') ||
        normalized.includes('saml') ||
        normalized.includes('customer onboarding')
      ) {
        return [0, 0, 0, 0, 1, 0, 0]
      }
      if (
        normalized.includes('customer trust') ||
        normalized.includes('hallucinated') ||
        normalized.includes('answer citations') ||
        normalized.includes('evidence-first') ||
        normalized.includes('grounded notes') ||
        normalized.includes('local notes first')
      ) {
        return [0, 0, 0, 0, 0, 1, 0]
      }
      if (normalized.includes('duet-display') || normalized.includes('slack channel')) {
        return [0, 0, 0, 0, 0, 0, 1]
      }
      return [0, 0, 0, 0, 0, 0, 0]
    })
  }
}
