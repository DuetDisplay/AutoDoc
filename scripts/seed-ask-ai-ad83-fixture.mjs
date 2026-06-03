#!/usr/bin/env node
import { mkdir, stat, writeFile } from 'fs/promises'
import { join, resolve } from 'path'

const args = process.argv.slice(2)
const recordingsDirArg = readArg('--recordings-dir')
const force = args.includes('--force')

if (!recordingsDirArg) {
  console.error(
    'Usage: node scripts/seed-ask-ai-ad83-fixture.mjs --recordings-dir <path> [--force]'
  )
  process.exit(1)
}

const recordingsDir = resolve(recordingsDirArg)

const fixtures = [
  {
    id: 'ad83-001-roadmap-review',
    title: 'AD83 Fixture - Roadmap Review',
    startedAt: Date.parse('2026-06-01T14:00:00Z'),
    topic: 'Roadmap',
    content: 'First listed fixture notes. The team discussed roadmap sequencing and beta timing.',
    category: 'information'
  },
  {
    id: 'ad83-002-support-triage',
    title: 'AD83 Fixture - Support Triage',
    startedAt: Date.parse('2026-06-01T13:00:00Z'),
    topic: 'Support',
    content:
      'Second listed fixture notes. Casey owns the escalation follow-up and the support macro audit is due Friday.',
    category: 'actionItems',
    assignee: 'Casey',
    deadline: 'Friday'
  },
  {
    id: 'ad83-003-design-sync',
    title: 'AD83 Fixture - Design Sync',
    startedAt: Date.parse('2026-06-01T12:00:00Z'),
    topic: 'Design',
    content: 'Third listed fixture notes. The group reviewed onboarding copy and empty states.',
    category: 'discussion'
  },
  {
    id: 'ad83-004-calendar-auth',
    title: 'AD83 Fixture - Calendar Auth Review',
    startedAt: Date.parse('2026-06-01T11:00:00Z'),
    topic: 'Calendar',
    content:
      'Fourth listed fixture notes. The team decided to verify Google Calendar scopes before release.',
    category: 'decisions'
  }
]

await mkdir(recordingsDir, { recursive: true })

for (const fixture of fixtures) {
  const meetingDir = join(recordingsDir, fixture.id)
  const exists = await stat(meetingDir)
    .then(() => true)
    .catch(() => false)
  if (exists && !force) {
    console.error(`${meetingDir} already exists. Re-run with --force to overwrite fixture files.`)
    process.exit(1)
  }

  await mkdir(meetingDir, { recursive: true })
  await writeFile(join(meetingDir, 'mic.webm'), '')
  await writeFile(
    join(meetingDir, 'metadata.json'),
    JSON.stringify(
      {
        sourceName: fixture.title,
        startedAt: fixture.startedAt,
        stoppedAt: fixture.startedAt + 30 * 60_000,
        durationSeconds: 30 * 60
      },
      null,
      2
    )
  )
  await writeFile(
    join(meetingDir, 'segments.json'),
    JSON.stringify(createSegments(fixture), null, 2)
  )
  await writeFile(
    join(meetingDir, 'transcript.json'),
    JSON.stringify(
      [
        {
          id: `${fixture.id}-transcript-1`,
          meetingId: fixture.id,
          speaker: 'speaker-1',
          text: fixture.content,
          startMs: 0,
          endMs: 10_000,
          confidence: 0.98
        }
      ],
      null,
      2
    )
  )
}

console.log(`Seeded ${fixtures.length} AD-83 Ask AI fixture recordings in ${recordingsDir}`)
console.log('Manual repro prompts:')
console.log('1. list my recordings')
console.log('2. show notes for the second one')
console.log('3. so, i have 8 recordings right?')
console.log('4. awesome, thank you!')
console.log('5. thanks, can you show action items?')

function readArg(name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  return args[index + 1] ?? null
}

function createSegments(fixture) {
  const segments = {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }
  const note = {
    id: `${fixture.id}-note-1`,
    meetingId: fixture.id,
    category: fixture.category === 'actionItems' ? 'action_item' : 'information',
    topic: fixture.topic,
    title: fixture.topic,
    content: fixture.content,
    assignee: fixture.assignee ?? null,
    deadline: fixture.deadline ?? null,
    sourceStartMs: 0,
    sourceEndMs: 10_000
  }
  segments[fixture.category].push(note)
  return segments
}
