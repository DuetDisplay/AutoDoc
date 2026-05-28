#!/usr/bin/env node
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const recordingsDir = join(homedir(), 'Library', 'Application Support', 'AutoDoc Dev', 'recordings')

const startedAt = new Date(2026, 4, 27, 9, 49).getTime()
const fixtures = [
  {
    id: 'mock-ad83-target-entire-screen-0949',
    sourceName: 'Entire screen',
    startedAt,
    note: 'MOCK AD-83 TARGET: This is the exact visible-title recording. The notes mention desktop capture, title lookup, and local Ask AI retrieval.'
  },
  {
    id: 'mock-ad83-entire-screen-0849',
    sourceName: 'Entire screen',
    startedAt: startedAt - 60 * 60_000,
    note: 'MOCK AD-83 distractor: Generic screen recording one hour earlier. It should not be selected for the 9:49 AM title.'
  },
  {
    id: 'mock-ad83-slack-huddle-0749',
    sourceName: 'Slack Huddle',
    startedAt: startedAt - 2 * 60 * 60_000,
    note: 'MOCK AD-83: Slack huddle notes about beta rollout, QA ownership, and follow-up actions.'
  },
  {
    id: 'mock-ad83-entire-screen-0649',
    sourceName: 'Entire screen',
    startedAt: startedAt - 3 * 60 * 60_000,
    note: 'MOCK AD-83 distractor: Another generic screen recording about unrelated transcription accuracy.'
  },
  {
    id: 'mock-ad83-calendar-sync',
    sourceName: 'Entire screen',
    calendarTitle: 'MOCK AD-83 Calendar Planning Sync',
    startedAt: startedAt + 60 * 60_000,
    note: 'MOCK AD-83 alias case: Calendar title should work as a lookup alias.'
  },
  {
    id: 'mock-ad83-custom-title',
    sourceName: 'Entire screen',
    customTitle: 'MOCK AD-83 Custom Product Review',
    startedAt: startedAt + 2 * 60 * 60_000,
    note: 'MOCK AD-83 alias case: Custom title should be preferred and searchable.'
  },
  {
    id: 'mock-ad83-source-title',
    sourceName: 'MOCK AD-83 Source Window',
    startedAt: startedAt + 3 * 60 * 60_000,
    note: 'MOCK AD-83 alias case: Source window title should be searchable when no custom or calendar title exists.'
  },
  {
    id: 'mock-ad83-structured-standup',
    sourceName: 'Entire screen',
    calendarTitle: 'MOCK AD-83 Daily Standup',
    startedAt: new Date(2026, 4, 26, 9, 30).getTime(),
    note: 'MOCK AD-83 structured question fixture for broad Ask AI Q&A.',
    segments: createStructuredQuestionSegments()
  },
  {
    id: 'mock-ad83-product-strategy-sync',
    sourceName: 'Entire screen',
    calendarTitle: 'MOCK AD-83 Product Strategy Sync',
    startedAt: new Date(2026, 4, 25, 10, 0).getTime(),
    note: 'MOCK AD-83 product strategy fixture.',
    segments: createSegmentsFromItems({
      decisions: [
        {
          title: 'Beta launch scope',
          content: 'Keep the June beta focused on retrieval accuracy, streaming answers, and calendar-scoped meeting summaries.',
          topic: 'beta launch'
        }
      ],
      actionItems: [
        {
          title: 'Draft beta launch plan',
          content: 'Draft the beta launch plan with risks, owner mapping, and success metrics.',
          topic: 'beta launch',
          assignee: 'Priya',
          deadline: '2026-05-29'
        }
      ],
      discussion: [
        {
          title: 'Customer trust',
          content: 'The team discussed that hallucinated action items would hurt customer trust more than a slower answer.',
          topic: 'Ask AI reliability'
        }
      ]
    })
  },
  {
    id: 'mock-ad83-engineering-reliability-review',
    sourceName: 'Entire screen',
    calendarTitle: 'MOCK AD-83 Engineering Reliability Review',
    startedAt: new Date(2026, 4, 27, 13, 0).getTime(),
    note: 'MOCK AD-83 engineering reliability fixture.',
    segments: createSegmentsFromItems({
      decisions: [
        {
          title: 'Use evidence-first retrieval',
          content: 'Adopt evidence-first retrieval so Ask AI sends grounded notes and transcript snippets to the model instead of relying on broad meeting dumps.',
          topic: 'Ask AI architecture'
        }
      ],
      actionItems: [
        {
          title: 'Investigate calendar auth scopes',
          content: 'Check whether insufficient Google Calendar scopes caused calendar fetch failures and add backoff when auth is broken.',
          topic: 'calendar reliability',
          assignee: 'Casey',
          deadline: '2026-05-28'
        }
      ],
      statusUpdates: [
        {
          title: 'Streaming progress',
          content: 'Streaming answers reduce perceived latency, but retrieval accuracy remains the product-critical blocker.',
          topic: 'Ask AI speed'
        }
      ]
    })
  },
  {
    id: 'mock-ad83-customer-escalation-call',
    sourceName: 'Entire screen',
    calendarTitle: 'MOCK AD-83 Customer Escalation Call',
    startedAt: new Date(2026, 4, 28, 11, 0).getTime(),
    note: 'MOCK AD-83 customer escalation fixture.',
    segments: createSegmentsFromItems({
      information: [
        {
          title: 'Customer reported missed title match',
          content: 'The customer could not find a recording by the visible title Entire screen May 27 at 9:49 AM.',
          topic: 'AD-83'
        }
      ],
      actionItems: [
        {
          title: 'Send customer follow-up',
          content: 'Send the customer a follow-up explaining the title lookup fix and the new evidence-based retrieval test plan.',
          topic: 'customer follow-up',
          assignee: 'Morgan',
          deadline: '2026-05-30'
        }
      ]
    })
  },
  {
    id: 'mock-ad83-old-week-sync',
    sourceName: 'Entire screen',
    calendarTitle: 'MOCK AD-83 Old Week Sync',
    startedAt: new Date(2026, 4, 20, 9, 30).getTime(),
    note: 'MOCK AD-83 old-week distractor fixture.',
    segments: createSegmentsFromItems({
      actionItems: [
        {
          title: 'Deprecated billing import',
          content: 'Investigate the deprecated billing import from the previous week.',
          topic: 'billing import',
          assignee: 'Riley',
          deadline: '2026-05-21'
        }
      ]
    })
  },
  {
    id: 'mock-ad83-transcript-only',
    sourceName: 'Entire screen',
    startedAt: startedAt + 4 * 60 * 60_000,
    note: null,
    transcript:
      'MOCK AD-83 transcript-only fixture. Ask AI should fall back to transcript text when meeting notes are missing.'
  },
  {
    id: 'mock-ad83-no-notes-yet',
    sourceName: 'Entire screen',
    startedAt: startedAt + 5 * 60 * 60_000,
    note: null,
    transcript: null,
    transcriptError: 'MOCK AD-83 failed transcription fixture.'
  }
]

for (let i = 0; i < 24; i += 1) {
  fixtures.push({
    id: `mock-ad83-bulk-${String(i + 1).padStart(2, '0')}`,
    sourceName: i % 4 === 0 ? 'Entire screen' : `MOCK AD-83 Bulk Recording ${i + 1}`,
    startedAt: startedAt - (i + 4) * 30 * 60_000,
    note: `MOCK AD-83 bulk fixture ${i + 1}. This exists to make the dev library larger than the old 5-recording cap and to exercise count/list behavior.`
  })
}

await mkdir(recordingsDir, { recursive: true })
const existing = new Set(await readdir(recordingsDir).catch(() => []))

let created = 0
let skipped = 0
for (const fixture of fixtures) {
  const meetingDir = join(recordingsDir, fixture.id)
  if (existing.has(fixture.id)) {
    if (fixture.segments) {
      await writeFile(join(meetingDir, 'segments.json'), JSON.stringify(fixture.segments))
    }
    if (fixture.transcriptError) {
      await writeFile(join(meetingDir, 'transcript.error'), fixture.transcriptError)
    }
    skipped += 1
    continue
  }

  await mkdir(meetingDir, { recursive: true })
  await writeFile(join(meetingDir, 'mic.webm'), '')
  await writeFile(
    join(meetingDir, 'metadata.json'),
    JSON.stringify({
      sourceName: fixture.sourceName,
      startedAt: fixture.startedAt,
      stoppedAt: fixture.startedAt + 30 * 60_000,
      durationSeconds: 30 * 60,
      customTitle: fixture.customTitle,
      calendarTitle: fixture.calendarTitle
    })
  )

  if (fixture.segments || fixture.note) {
    await writeFile(
      join(meetingDir, 'segments.json'),
      JSON.stringify(fixture.segments ?? createSegments(fixture.note))
    )
  }

  if (fixture.transcript !== null) {
    await writeFile(
      join(meetingDir, 'transcript.json'),
      JSON.stringify([
        {
          id: `${fixture.id}-transcript-1`,
          meetingId: fixture.id,
          speaker: 'speaker-1',
          text: fixture.transcript ?? fixture.note ?? 'MOCK AD-83 transcript placeholder.',
          startMs: 0,
          endMs: 10_000,
          confidence: 0.99
        }
      ])
    )
  }

  if (fixture.transcriptError) {
    await writeFile(join(meetingDir, 'transcript.error'), fixture.transcriptError)
  }

  created += 1
}

console.log(
  JSON.stringify(
    {
      recordingsDir,
      created,
      skipped,
      totalFixtures: fixtures.length,
      exactTitleToAsk: 'Entire screen — May 27 at 9:49 AM',
      usefulQuestions: [
        'Summarize Entire screen — May 27 at 9:49 AM',
        'How many recordings do I have?',
        'List my recordings',
        'Summarize all of my recordings',
        'Summarize MOCK AD-83 Custom Product Review',
        'What happened in the MOCK AD-83 bulk fixtures?',
        'Which meeting did we discuss billing migration?',
        'Who was assigned to do the billing migration checklist action?',
        'What is the due date for billing checklist?',
        'In yesterday’s standup did we talk about billing migration?',
        'What tasks do I have to complete this week?',
        'What action items came out of this weeks MOCK AD-83 meetings?',
        'Who owns the calendar auth scope investigation?',
        'What did we decide about evidence-first retrieval?',
        'Which meeting mentioned customer trust?',
        'What was discussed in the customer escalation call?',
        'Summarize this weeks MOCK AD-83 meetings, but do not include last week'
      ]
    },
    null,
    2
  )
)

function createSegments(content) {
  return {
    decisions: [
      {
        id: 'decision-1',
        meetingId: 'mock-fixture',
        category: 'decision',
        topic: 'Ask AI',
        title: 'Fixture expectation',
        content,
        assignee: null,
        deadline: null,
        sourceStartMs: 0,
        sourceEndMs: 10_000
      }
    ],
    actionItems: [
      {
        id: 'action-1',
        meetingId: 'mock-fixture',
        category: 'action_item',
        topic: 'QA',
        title: 'Manual verification',
        content: 'Use Ask AI to confirm exact-title retrieval and library-size behavior.',
        assignee: 'QA',
        deadline: null,
        sourceStartMs: 10_000,
        sourceEndMs: 20_000
      }
    ],
    information: [],
    discussion: [],
    statusUpdates: []
  }
}

function createSegmentsFromItems(items) {
  const segments = {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }

  for (const [category, categoryItems] of Object.entries(items)) {
    segments[category] = categoryItems.map((item, index) => ({
      id: `${category}-${index}`,
      meetingId: 'mock-fixture',
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

function segmentCategoryForKey(category) {
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
    default:
      return 'information'
  }
}

function createStructuredQuestionSegments() {
  return {
    decisions: [],
    actionItems: [
      {
        id: 'action-billing-checklist',
        meetingId: 'mock-ad83-structured-standup',
        category: 'action_item',
        topic: 'billing migration',
        title: 'Prepare billing checklist',
        content: 'Prepare the billing migration checklist before rollout.',
        assignee: 'Alex',
        deadline: '2026-05-29',
        sourceStartMs: 10_000,
        sourceEndMs: 20_000
      }
    ],
    information: [
      {
        id: 'info-billing-migration',
        meetingId: 'mock-ad83-structured-standup',
        category: 'information',
        topic: 'billing migration',
        title: 'Billing migration',
        content: 'The team discussed the billing migration risk and rollout sequencing.',
        assignee: null,
        deadline: null,
        sourceStartMs: 0,
        sourceEndMs: 10_000
      }
    ],
    discussion: [],
    statusUpdates: []
  }
}
