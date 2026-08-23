import { createHash } from 'crypto'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MeetingNotesContent,
  MeetingNotesV2,
  MeetingSegments,
  Transcript
} from '../../../shared/types'
import { loadMeetingExportSnapshot } from '../meeting-export-sources'
import {
  computeNotesAttributionRevision,
  computeNotesRevision,
  computeTranscriptRevision
} from '../notes-revision'

let mockPaths = { appData: '', userData: '' }

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: {
    get isPackaged() {
      return true
    },
    getPath: vi.fn((name: string) => mockPaths[name as keyof typeof mockPaths])
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().replace(/^enc:/, ''))
  }
}))

interface FileFingerprint {
  sha256: string
  size: number
  mtimeMs: number
}

function transcriptRow(meetingId: string): Transcript {
  return {
    id: 'utterance-1',
    meetingId,
    speaker: 'speaker-1',
    text: 'Ship the export flow after visual QA.',
    startMs: 1_250,
    endMs: 4_750,
    confidence: 0.97
  }
}

function legacySegments(meetingId: string): MeetingSegments {
  return {
    decisions: [
      {
        id: 'decision-1',
        meetingId,
        category: 'decision',
        topic: 'Export',
        title: 'Ship document exports',
        content: 'Markdown, PDF, and Word will ship together.',
        assignee: 'Chris',
        deadline: '2026-08-30',
        sourceStartMs: 1_250,
        sourceEndMs: 4_750
      }
    ],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }
}

function v2Notes(meetingId: string): MeetingNotesV2 {
  const content: MeetingNotesContent = {
    overview: {
      text: 'The team approved the document export plan.',
      sources: [{ startMs: 1_250, endMs: 4_750 }],
      provenance: 'generated'
    },
    keyTakeaways: [],
    sections: [],
    decisions: [],
    nextSteps: []
  }
  const sourceTranscriptRevision = computeTranscriptRevision(meetingId, [
    { startMs: 1_250, text: 'Ship the export flow after visual QA.' }
  ])
  const sourceAttributionRevision = computeNotesAttributionRevision(meetingId, [
    { id: 'speaker-1', confirmedSpeakerLabel: 'Chris' }
  ])
  return {
    schemaVersion: 2,
    meetingId,
    sourceTranscriptRevision,
    sourceAttributionRevision,
    revision: computeNotesRevision(
      meetingId,
      sourceTranscriptRevision,
      sourceAttributionRevision,
      content
    ),
    ...content
  }
}

describe('loadMeetingExportSnapshot', () => {
  let root: string
  let recordingsDir: string

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-meeting-export-sources-'))
    recordingsDir = path.join(root, 'recordings')
    mockPaths = {
      appData: path.join(root, 'app-data'),
      userData: path.join(root, 'user-data')
    }
    await Promise.all([
      fsp.mkdir(recordingsDir),
      fsp.mkdir(mockPaths.appData),
      fsp.mkdir(mockPaths.userData)
    ])
  })

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true })
  })

  async function createMeeting(meetingId: string): Promise<string> {
    const meetingDir = path.join(recordingsDir, meetingId)
    await fsp.mkdir(meetingDir)
    return meetingDir
  }

  async function writeJson(directory: string, filename: string, value: unknown): Promise<string> {
    const filePath = path.join(directory, filename)
    await fsp.writeFile(filePath, JSON.stringify(value))
    return filePath
  }

  async function fingerprint(filePath: string): Promise<FileFingerprint> {
    const [bytes, stats] = await Promise.all([fsp.readFile(filePath), fsp.stat(filePath)])
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: stats.size,
      mtimeMs: stats.mtimeMs
    }
  }

  it('loads exact legacy notes, transcript, speakers, and persisted title metadata without touching source files', async () => {
    const meetingId = 'meeting-legacy-export'
    const meetingDir = await createMeeting(meetingId)
    const transcript = [transcriptRow(meetingId)]
    const speakers = {
      'speaker-1': { label: 'Chris', suggestions: ['Chris', 'Christopher'] }
    }
    const metadata = {
      sourceName: 'Screen 1',
      startedAt: Date.UTC(2026, 7, 23, 14, 30),
      stoppedAt: Date.UTC(2026, 7, 23, 15, 0),
      durationSeconds: 1_800,
      calendarTitle: 'Export Design Review',
      customTitle: 'Customer-ready export plan'
    }
    const sourceFiles = await Promise.all([
      writeJson(meetingDir, 'segments.json', legacySegments(meetingId)),
      writeJson(meetingDir, 'transcript.json', transcript),
      writeJson(meetingDir, 'speakers.json', speakers),
      writeJson(meetingDir, 'metadata.json', metadata)
    ])
    const before = await Promise.all(sourceFiles.map(fingerprint))
    const entriesBefore = await fsp.readdir(meetingDir)

    const snapshot = await loadMeetingExportSnapshot(recordingsDir, meetingId)

    expect(snapshot.detail).toEqual({
      title: 'Customer-ready export plan',
      sourceName: 'Export Design Review',
      date: metadata.startedAt,
      durationSeconds: metadata.durationSeconds
    })
    expect(snapshot.transcript).toEqual(transcript)
    expect(snapshot.speakers).toEqual(speakers)
    expect(snapshot.notes).toMatchObject({
      normalizedSchemaVersion: 1,
      meetingId,
      source: { format: 'legacy-segments', adapterVersion: 1 },
      decisions: [
        {
          id: 'decision-1',
          title: 'Ship document exports',
          text: 'Markdown, PDF, and Word will ship together.',
          owner: 'Chris',
          deadline: '2026-08-30',
          provenance: 'legacy',
          sources: [{ startMs: 1_250, endMs: 4_750 }]
        }
      ]
    })

    expect(await Promise.all(sourceFiles.map(fingerprint))).toEqual(before)
    expect((await fsp.readdir(meetingDir)).sort()).toEqual(entriesBefore.sort())
  })

  it('loads and normalizes a valid plaintext Notes V2 document', async () => {
    const meetingId = 'meeting-v2-export'
    const meetingDir = await createMeeting(meetingId)
    const notes = v2Notes(meetingId)
    await Promise.all([
      writeJson(meetingDir, 'notes.json', notes),
      writeJson(meetingDir, 'metadata.json', {
        sourceName: 'Entire Screen',
        startedAt: 1_777_000_000_000,
        stoppedAt: 1_777_000_060_000,
        durationSeconds: 60,
        customTitle: 'Notes V2 export'
      })
    ])

    const snapshot = await loadMeetingExportSnapshot(recordingsDir, meetingId)

    expect(snapshot.detail.title).toBe('Notes V2 export')
    expect(snapshot.notes).toEqual({
      normalizedSchemaVersion: 1,
      meetingId,
      source: { format: 'notes-v2', schemaVersion: 2 },
      sourceTranscriptRevision: notes.sourceTranscriptRevision,
      sourceAttributionRevision: notes.sourceAttributionRevision,
      revision: notes.revision,
      overview: notes.overview,
      keyTakeaways: [],
      sections: [],
      decisions: [],
      nextSteps: []
    })
  })

  it('treats transcript, speakers, metadata, and notes as independently optional', async () => {
    const meetingId = 'meeting-empty-export'
    const meetingDir = await createMeeting(meetingId)
    const meetingStats = await fsp.stat(meetingDir)

    const snapshot = await loadMeetingExportSnapshot(recordingsDir, meetingId)

    expect(snapshot).toEqual({
      detail: {
        title: expect.stringMatching(/^Recording /),
        sourceName: null,
        date: meetingStats.birthtimeMs,
        durationSeconds: null
      },
      notes: null,
      transcript: [],
      speakers: {}
    })
    expect(await fsp.readdir(meetingDir)).toEqual([])
  })

  it.each(['../outside-meeting', '/tmp/outside-meeting', '', '.', '..', 'nested/meeting'])(
    'rejects unsafe meeting identifier %j before reading paths outside the recordings directory',
    async (meetingId) => {
      const outsideDir = path.join(root, 'outside-meeting')
      await fsp.mkdir(outsideDir, { recursive: true })
      await fsp.writeFile(path.join(outsideDir, 'transcript.json'), '{deliberately-invalid-json')

      await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toMatchObject({
        name: 'NotesRepositoryError',
        code: 'INVALID_MEETING_ID'
      })
    }
  )

  it('rejects a meeting directory symlink', async () => {
    const meetingId = 'symlinked-meeting'
    const outsideDir = path.join(root, 'outside-symlink-target')
    await fsp.mkdir(outsideDir)
    await fsp.symlink(outsideDir, path.join(recordingsDir, meetingId), 'dir')

    await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toMatchObject({
      name: 'NotesRepositoryError',
      code: 'UNSAFE_STORAGE_ENTRY'
    })
  })

  it('rejects a symlinked optional export source file', async () => {
    const meetingId = 'meeting-symlinked-transcript'
    const meetingDir = await createMeeting(meetingId)
    const outsideTranscript = path.join(root, 'outside-transcript.json')
    await fsp.writeFile(outsideTranscript, JSON.stringify([transcriptRow(meetingId)]))
    await fsp.symlink(outsideTranscript, path.join(meetingDir, 'transcript.json'), 'file')

    await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toThrow(
      'Unsafe export source data'
    )
  })

  it.each([
    {
      name: 'an extra field',
      build: (meetingId: string) => ({ ...transcriptRow(meetingId), privateField: 'leak' })
    },
    {
      name: 'a missing field',
      build: (meetingId: string) => {
        const row: Partial<Transcript> = transcriptRow(meetingId)
        delete row.confidence
        return row
      }
    },
    {
      name: 'a mismatched meeting ID',
      build: (meetingId: string) => ({ ...transcriptRow(meetingId), meetingId: 'another-meeting' })
    },
    {
      name: 'a negative timestamp',
      build: (meetingId: string) => ({ ...transcriptRow(meetingId), startMs: -1 })
    },
    {
      name: 'an end before its start',
      build: (meetingId: string) => ({ ...transcriptRow(meetingId), endMs: 1_000 })
    },
    {
      name: 'a nonnumeric confidence',
      build: (meetingId: string) => ({ ...transcriptRow(meetingId), confidence: 'high' })
    }
  ])('rejects transcript rows containing $name', async ({ build }) => {
    const meetingId = 'meeting-invalid-transcript'
    const meetingDir = await createMeeting(meetingId)
    await writeJson(meetingDir, 'transcript.json', [build(meetingId)])

    await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toThrow(
      /Invalid (transcript|export source) data/
    )
  })

  it('rejects syntactically corrupt transcript JSON', async () => {
    const meetingId = 'meeting-corrupt-transcript'
    const meetingDir = await createMeeting(meetingId)
    await fsp.writeFile(path.join(meetingDir, 'transcript.json'), '[{"id":')

    await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toBeInstanceOf(
      SyntaxError
    )
  })

  it.each([
    { name: 'a non-object speaker map', value: [] },
    { name: 'an unknown speaker field', value: { 'speaker-1': { label: 'Chris', color: 'sage' } } },
    { name: 'a non-string label', value: { 'speaker-1': { label: 42 } } },
    {
      name: 'a non-string suggestion',
      value: { 'speaker-1': { label: 'Chris', suggestions: ['Chris', 42] } }
    }
  ])('rejects malformed speakers with $name', async ({ value }) => {
    const meetingId = 'meeting-invalid-speakers'
    const meetingDir = await createMeeting(meetingId)
    await writeJson(meetingDir, 'speakers.json', value)

    await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toThrow(
      /Invalid (export source|speaker) data/
    )
  })

  it('rejects malformed persisted metadata instead of fabricating export details', async () => {
    const meetingId = 'meeting-invalid-metadata'
    const meetingDir = await createMeeting(meetingId)
    await writeJson(meetingDir, 'metadata.json', {
      sourceName: 'Screen 1',
      startedAt: 'yesterday',
      stoppedAt: 100,
      durationSeconds: 10
    })

    await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toThrow(
      'Invalid meeting metadata'
    )
  })
})
