import { createHash } from 'crypto'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingNotesContent, MeetingNotesV2, MeetingSegments } from '../../../shared/types'
import { encryptJSON } from '../crypto'
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
    sections: [
      {
        id: 'section-1',
        title: 'Export scope',
        summary: {
          text: 'Exports contain generated notes only.',
          sources: [{ startMs: 4_751, endMs: 7_000 }],
          provenance: 'generated'
        },
        keyPoints: [],
        supportingDetails: []
      }
    ],
    decisions: [],
    nextSteps: []
  }
  const sourceTranscriptRevision = computeTranscriptRevision(meetingId, [
    { startMs: 1_250, text: 'Private transcript source not exported.' }
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

  it('loads exact legacy notes and title metadata while ignoring transcript and speaker bytes', async () => {
    const meetingId = 'meeting-legacy-export'
    const meetingDir = await createMeeting(meetingId)
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
      writeJson(meetingDir, 'metadata.json', metadata),
      writeJson(meetingDir, 'transcript.json', 'TRANSCRIPT_PRIVATE_INVALID_SHAPE'),
      writeJson(meetingDir, 'speakers.json', 'SPEAKERS_PRIVATE_INVALID_SHAPE')
    ])
    const before = await Promise.all(sourceFiles.map(fingerprint))
    const entriesBefore = await fsp.readdir(meetingDir)

    const snapshot = await loadMeetingExportSnapshot(recordingsDir, meetingId)

    expect(snapshot).toEqual({
      detail: {
        title: 'Customer-ready export plan',
        sourceName: 'Export Design Review',
        date: metadata.startedAt,
        durationSeconds: metadata.durationSeconds
      },
      notes: expect.objectContaining({
        normalizedSchemaVersion: 1,
        meetingId,
        source: { format: 'legacy-segments', adapterVersion: 1 },
        decisions: [
          expect.objectContaining({
            id: 'decision-1',
            title: 'Ship document exports',
            text: 'Markdown, PDF, and Word will ship together.',
            owner: 'Chris',
            deadline: '2026-08-30',
            provenance: 'legacy',
            sources: [{ startMs: 1_250, endMs: 4_750 }]
          })
        ]
      })
    })
    expect(snapshot).not.toHaveProperty('transcript')
    expect(snapshot).not.toHaveProperty('speakers')
    expect(await Promise.all(sourceFiles.map(fingerprint))).toEqual(before)
    expect((await fsp.readdir(meetingDir)).sort()).toEqual(entriesBefore.sort())
  })

  it('decrypts only Notes V2 and metadata while malformed private sources remain irrelevant', async () => {
    const meetingId = 'meeting-encrypted-v2-export'
    const meetingDir = await createMeeting(meetingId)
    const persistedNotes = v2Notes(meetingId)
    const metadata = {
      sourceName: 'Entire Screen',
      startedAt: 1_777_000_000_000,
      stoppedAt: 1_777_000_060_000,
      durationSeconds: 60,
      customTitle: 'Encrypted Notes V2 export'
    }
    await Promise.all([
      encryptJSON(persistedNotes, path.join(meetingDir, 'notes.json')),
      encryptJSON(metadata, path.join(meetingDir, 'metadata.json')),
      fsp.writeFile(path.join(meetingDir, 'transcript.json'), '{not valid json'),
      fsp.writeFile(path.join(meetingDir, 'speakers.json'), '{not valid json')
    ])

    const snapshot = await loadMeetingExportSnapshot(recordingsDir, meetingId)

    expect(snapshot.detail).toEqual({
      title: 'Encrypted Notes V2 export',
      sourceName: 'Entire Screen',
      date: metadata.startedAt,
      durationSeconds: 60
    })
    expect(snapshot.notes).toEqual({
      normalizedSchemaVersion: 1,
      meetingId,
      source: { format: 'notes-v2', schemaVersion: 2 },
      sourceTranscriptRevision: persistedNotes.sourceTranscriptRevision,
      sourceAttributionRevision: persistedNotes.sourceAttributionRevision,
      revision: persistedNotes.revision,
      overview: persistedNotes.overview,
      keyTakeaways: [],
      sections: persistedNotes.sections.map((section) => ({
        ...section,
        keyPoints: [],
        supportingDetails: []
      })),
      decisions: [],
      nextSteps: []
    })
    expect(Object.keys(snapshot).sort()).toEqual(['detail', 'notes'])
  })

  it('does not inspect transcript or speaker paths at all', async () => {
    const meetingId = 'meeting-private-source-directories'
    const meetingDir = await createMeeting(meetingId)
    await Promise.all([
      writeJson(meetingDir, 'segments.json', legacySegments(meetingId)),
      fsp.mkdir(path.join(meetingDir, 'transcript.json')),
      fsp.mkdir(path.join(meetingDir, 'speakers.json'))
    ])

    const snapshot = await loadMeetingExportSnapshot(recordingsDir, meetingId)

    expect(snapshot.notes?.decisions[0].text).toBe('Markdown, PDF, and Word will ship together.')
    expect(snapshot).not.toHaveProperty('transcript')
    expect(snapshot).not.toHaveProperty('speakers')
  })

  it('treats metadata and notes as independently optional', async () => {
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
      notes: null
    })
    expect(await fsp.readdir(meetingDir)).toEqual([])
  })

  it.each(['../outside-meeting', '/tmp/outside-meeting', '', '.', '..', 'nested/meeting'])(
    'rejects unsafe meeting identifier %j before reading paths outside the recordings directory',
    async (meetingId) => {
      const outsideDir = path.join(root, 'outside-meeting')
      await fsp.mkdir(outsideDir, { recursive: true })
      await fsp.writeFile(path.join(outsideDir, 'metadata.json'), '{deliberately-invalid-json')

      await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toMatchObject({
        name: 'NotesRepositoryError',
        code: 'INVALID_MEETING_ID'
      })
    }
  )

  it.skipIf(process.platform === 'win32')('rejects a meeting directory symlink', async () => {
    const meetingId = 'symlinked-meeting'
    const outsideDir = path.join(root, 'outside-symlink-target')
    await fsp.mkdir(outsideDir)
    await fsp.symlink(outsideDir, path.join(recordingsDir, meetingId), 'dir')

    await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toMatchObject({
      name: 'NotesRepositoryError',
      code: 'UNSAFE_STORAGE_ENTRY'
    })
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked metadata file', async () => {
    const meetingId = 'meeting-symlinked-metadata'
    const meetingDir = await createMeeting(meetingId)
    const outsideMetadata = path.join(root, 'outside-metadata.json')
    await fsp.writeFile(
      outsideMetadata,
      JSON.stringify({
        sourceName: 'Screen',
        startedAt: 1,
        stoppedAt: 2,
        durationSeconds: 1
      })
    )
    await fsp.symlink(outsideMetadata, path.join(meetingDir, 'metadata.json'), 'file')

    await expect(loadMeetingExportSnapshot(recordingsDir, meetingId)).rejects.toThrow(
      'Unsafe export source data'
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
