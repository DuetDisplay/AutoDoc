import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import type {
  MeetingNotesContent,
  MeetingNotesV2,
  MeetingSegments,
  NotesAttributionRevision,
  TranscriptRevision
} from '../../../shared/types'
import {
  computeNotesAttributionRevision,
  computeNotesRevision,
  computeTranscriptRevision
} from '../notes-revision'
import { NOTES_ENCRYPTED_MAX_BYTES } from '../notes-schema'

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

async function freshModules(): Promise<
  typeof import('../notes-repository') &
    typeof import('../crypto') &
    typeof import('../notes-revision')
> {
  vi.resetModules()
  const [repository, crypto, revision] = await Promise.all([
    import('../notes-repository'),
    import('../crypto'),
    import('../notes-revision')
  ])
  return { ...repository, ...crypto, ...revision }
}

function sourceRevision(meetingId: string): TranscriptRevision {
  return computeTranscriptRevision(meetingId, [{ startMs: 0, text: 'transcript' }])
}

function attributionRevision(meetingId: string): NotesAttributionRevision {
  return computeNotesAttributionRevision(meetingId, [
    { id: 'speaker-1', confirmedSpeakerLabel: 'Me' }
  ])
}

function sourceBindings(meetingId: string) {
  return {
    sourceTranscriptRevision: sourceRevision(meetingId),
    sourceAttributionRevision: attributionRevision(meetingId)
  }
}

const overviewSources = [
  { startMs: 0, endMs: 1_000 },
  { startMs: 900, endMs: 2_000 },
  { startMs: 2_000, endMs: 3_000 }
]

function content(text = 'Overview'): MeetingNotesContent {
  return {
    overview: {
      text,
      sources: [
        { startMs: 2_000, endMs: 3_000 },
        { startMs: 0, endMs: 1_000 },
        { startMs: 900, endMs: 2_000 },
        { startMs: 900, endMs: 2_000 }
      ],
      provenance: 'generated'
    },
    keyTakeaways: [],
    sections: [
      {
        id: 'topic-1',
        title: 'Topic',
        summary: null,
        keyPoints: [
          {
            id: 'point-1',
            title: null,
            topic: 'Topic',
            owner: null,
            deadline: null,
            text: 'Detail',
            sources: [{ startMs: 5_000, endMs: 6_000 }],
            provenance: 'user-edited'
          }
        ],
        supportingDetails: []
      }
    ],
    decisions: [],
    nextSteps: []
  }
}

function notesV2(meetingId: string, text = 'Overview'): MeetingNotesV2 {
  const draft = content(text)
  const sourceTranscriptRevision = sourceRevision(meetingId)
  const sourceAttributionRevision = attributionRevision(meetingId)
  return {
    schemaVersion: 2,
    meetingId,
    sourceTranscriptRevision,
    sourceAttributionRevision,
    revision: computeNotesRevision(
      meetingId,
      sourceTranscriptRevision,
      sourceAttributionRevision,
      draft
    ),
    ...draft
  }
}

function legacy(meetingId: string): MeetingSegments {
  return {
    decisions: [
      {
        id: 'legacy-decision',
        meetingId,
        category: 'decision',
        topic: null,
        title: 'Legacy decision',
        content: 'Keep legacy bytes unchanged',
        assignee: null,
        deadline: null,
        sourceStartMs: 10,
        sourceEndMs: 20
      }
    ],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'NotesRepositoryError', code })
}

describe('NotesRepository', () => {
  let root: string
  let recordingsDir: string

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-notes-repository-'))
    recordingsDir = path.join(root, 'recordings')
    mockPaths = { appData: path.join(root, 'app-data'), userData: path.join(root, 'user-data') }
    await Promise.all([
      fsp.mkdir(recordingsDir),
      fsp.mkdir(mockPaths.appData),
      fsp.mkdir(mockPaths.userData)
    ])
  })

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true })
  })

  async function meeting(meetingId: string): Promise<string> {
    const directory = path.join(recordingsDir, meetingId)
    await fsp.mkdir(directory)
    return directory
  }

  it('writes only encrypted, validated V2 data and preserves complete normalized evidence', async () => {
    const meetingId = 'meeting-v2'
    const meetingDir = await meeting(meetingId)
    const { NotesRepository, decryptJSON } = await freshModules()
    const repository = new NotesRepository(recordingsDir)

    const written = await repository.writeV2(meetingId, content(), {
      expectedRevision: null,
      ...sourceBindings(meetingId)
    })
    const stored = await fsp.readFile(path.join(meetingDir, 'notes.json'))
    const normalized = await repository.read(meetingId)

    expect(stored.subarray(0, 4).toString('ascii')).toBe('ADOC')
    expect(await decryptJSON(path.join(meetingDir, 'notes.json'))).toEqual(written)
    expect((await fsp.readdir(meetingDir)).filter((entry) => entry.endsWith('.enc'))).toEqual([])
    expect(normalized).toMatchObject({
      source: { format: 'notes-v2' },
      sourceTranscriptRevision: sourceRevision(meetingId),
      sourceAttributionRevision: attributionRevision(meetingId),
      overview: {
        provenance: 'generated',
        sources: overviewSources
      }
    })
    expect(normalized?.sections[0].keyPoints[0].provenance).toBe('user-edited')
  })

  it('uses strict V2 precedence without revealing corrupt V2 or falling back to legacy', async () => {
    const meetingId = 'meeting-precedence'
    const meetingDir = await meeting(meetingId)
    await fsp.writeFile(path.join(meetingDir, 'segments.json'), JSON.stringify(legacy(meetingId)))
    await fsp.writeFile(path.join(meetingDir, 'notes.json'), '{"private":"not valid V2"}')
    const { NotesRepository } = await freshModules()

    try {
      await new NotesRepository(recordingsDir).read(meetingId)
      throw new Error('Expected corrupt V2 to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_NOTES' })
      expect(JSON.stringify(error)).not.toContain('private')
      expect(String((error as Error).message)).not.toContain(meetingId)
    }
  })

  it('preserves generation identity on edits and renews it when notes are regenerated', async () => {
    const meetingId = 'generation-feedback'
    const meetingDir = await meeting(meetingId)
    const { NotesRepository } = await freshModules()
    const repository = new NotesRepository(recordingsDir)
    const original = await repository.writeV2(meetingId, content(), { expectedRevision: null, ...sourceBindings(meetingId) })
    expect(original.generation).toMatchObject({ id: expect.any(String), engineVersion: 'v2.1' })
    const edited = await repository.writeV2(meetingId, content('Edited'), { expectedRevision: original.revision, ...sourceBindings(meetingId) })
    expect(edited.generation).toEqual(original.generation)
    // The pipeline replaces notes.json before promoting the fresh generation.
    await fsp.unlink(path.join(meetingDir, 'notes.json'))
    const regenerated = await repository.writeV2(meetingId, content('Edited'), { expectedRevision: null, ...sourceBindings(meetingId) })
    expect(regenerated.revision).toBe(edited.revision)
    expect(regenerated.generation?.id).not.toBe(edited.generation?.id)
  })

  it('rejects authenticated V2 ciphertext copied from a different meeting', async () => {
    const firstId = 'meeting-swap-first'
    const secondId = 'meeting-swap-second'
    const firstDir = await meeting(firstId)
    const secondDir = await meeting(secondId)
    const { NotesRepository } = await freshModules()
    const repository = new NotesRepository(recordingsDir)
    await repository.writeV2(firstId, content('First'), {
      expectedRevision: null,
      ...sourceBindings(firstId)
    })
    await repository.writeV2(secondId, content('Second'), {
      expectedRevision: null,
      ...sourceBindings(secondId)
    })

    await fsp.copyFile(path.join(firstDir, 'notes.json'), path.join(secondDir, 'notes.json'))
    await expectCode(repository.readV2(secondId), 'INVALID_NOTES')
  })

  it('migrates a validated historical plaintext V2 through the write queue', async () => {
    const meetingId = 'meeting-plaintext'
    const meetingDir = await meeting(meetingId)
    const { NotesRepository, decryptJSON } = await freshModules()
    const notes = notesV2(meetingId, 'Historical')
    const transcriptRevision = notes.sourceTranscriptRevision
    await fsp.writeFile(path.join(meetingDir, 'notes.json'), JSON.stringify(notes))
    const repository = new NotesRepository(recordingsDir)

    await expect(repository.migratePlaintextV2(meetingId)).resolves.toBe(true)
    expect(
      (await fsp.readFile(path.join(meetingDir, 'notes.json'))).subarray(0, 4).toString()
    ).toBe('ADOC')
    await expect(decryptJSON(path.join(meetingDir, 'notes.json'))).resolves.toMatchObject({
      meetingId,
      revision: notes.revision,
      sourceTranscriptRevision: transcriptRevision,
      overview: {
        sources: overviewSources
      }
    })
    await expect(repository.migratePlaintextV2(meetingId)).resolves.toBe(false)
  })

  it('leaves invalid plaintext V2 byte-for-byte unchanged', async () => {
    const meetingId = 'meeting-invalid-plaintext'
    const meetingDir = await meeting(meetingId)
    const notesPath = path.join(meetingDir, 'notes.json')
    const before = Buffer.from('{"private":"invalid notes"}')
    await fsp.writeFile(notesPath, before)
    const { NotesRepository } = await freshModules()

    await expectCode(
      new NotesRepository(recordingsDir).migratePlaintextV2(meetingId),
      'INVALID_NOTES'
    )
    expect((await fsp.readFile(notesPath)).equals(before)).toBe(true)
  })

  it('routes validated plaintext V2 through migrateRecordings without content-bearing logs', async () => {
    const meetingId = 'meeting-startup-migration'
    const meetingDir = await meeting(meetingId)
    const { isEncrypted, migrateRecordings } = await freshModules()
    await fsp.writeFile(
      path.join(meetingDir, 'notes.json'),
      JSON.stringify(notesV2(meetingId, 'PRIVATE MIGRATION CONTENT'))
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await migrateRecordings(recordingsDir)
      expect(await isEncrypted(path.join(meetingDir, 'notes.json'))).toBe(true)
      expect(log.mock.calls.flat().join(' ')).not.toMatch(/meeting-startup|PRIVATE MIGRATION/)
    } finally {
      log.mockRestore()
    }
  })

  it('continues notes migration after invalid plaintext and reports one content-free failure', async () => {
    const invalidId = '000-invalid-notes'
    const validId = '999-valid-notes'
    const invalidDir = await meeting(invalidId)
    const validDir = await meeting(validId)
    const invalidPath = path.join(invalidDir, 'notes.json')
    const validPath = path.join(validDir, 'notes.json')
    const invalidBytes = Buffer.from('{"private":"INVALID PRIVATE CONTENT"}')
    await fsp.writeFile(invalidPath, invalidBytes)
    await fsp.writeFile(validPath, JSON.stringify(notesV2(validId, 'VALID PRIVATE CONTENT')))
    const { isEncrypted, migrateRecordings } = await freshModules()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await expect(migrateRecordings(recordingsDir)).rejects.toThrow(
        'Could not migrate one or more encrypted meeting notes'
      )
      expect((await fsp.readFile(invalidPath)).equals(invalidBytes)).toBe(true)
      expect(await isEncrypted(validPath)).toBe(true)
      expect(log.mock.calls.flat().join(' ')).not.toMatch(
        /000-invalid|999-valid|INVALID PRIVATE|VALID PRIVATE/
      )
    } finally {
      log.mockRestore()
    }
  })

  it('serializes compare-and-write so only one divergent update succeeds', async () => {
    const meetingId = 'meeting-race'
    await meeting(meetingId)
    const { NotesRepository } = await freshModules()
    const first = new NotesRepository(recordingsDir)
    const second = new NotesRepository(recordingsDir)
    const initial = await first.writeV2(meetingId, content('Initial'), {
      expectedRevision: null,
      ...sourceBindings(meetingId)
    })

    const writes = await Promise.allSettled([
      first.writeV2(meetingId, content('First'), {
        expectedRevision: initial.revision,
        ...sourceBindings(meetingId)
      }),
      second.writeV2(meetingId, content('Second'), {
        expectedRevision: initial.revision,
        ...sourceBindings(meetingId)
      })
    ])

    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(writes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CONFLICT' }
    })
  })

  it('rejects ordinary updates that attempt to rebind source revisions', async () => {
    const meetingId = 'meeting-stale-rebind'
    const meetingDir = await meeting(meetingId)
    const { NotesRepository } = await freshModules()
    const repository = new NotesRepository(recordingsDir)
    const initial = await repository.writeV2(meetingId, content('Initial'), {
      expectedRevision: null,
      ...sourceBindings(meetingId)
    })
    const before = await fsp.readFile(path.join(meetingDir, 'notes.json'))
    const replacementTranscript = computeTranscriptRevision(meetingId, [
      { startMs: 0, text: 'replacement transcript' }
    ])

    await expectCode(
      repository.writeV2(meetingId, content('Falsely current'), {
        expectedRevision: initial.revision,
        sourceTranscriptRevision: replacementTranscript,
        sourceAttributionRevision: initial.sourceAttributionRevision
      }),
      'REVISION_CONFLICT'
    )
    const replacementAttribution = computeNotesAttributionRevision(meetingId, [
      { id: 'speaker-1', confirmedSpeakerLabel: 'Renamed' }
    ])
    await expectCode(
      repository.writeV2(meetingId, content('Falsely attributed'), {
        expectedRevision: initial.revision,
        sourceTranscriptRevision: initial.sourceTranscriptRevision,
        sourceAttributionRevision: replacementAttribution
      }),
      'REVISION_CONFLICT'
    )
    expect((await fsp.readFile(path.join(meetingDir, 'notes.json'))).equals(before)).toBe(true)
    await expect(repository.readV2(meetingId)).resolves.toMatchObject({
      sourceTranscriptRevision: initial.sourceTranscriptRevision,
      sourceAttributionRevision: initial.sourceAttributionRevision,
      overview: { text: 'Initial' }
    })
  })

  it('keeps the prior ciphertext intact when an atomic replacement fails', async () => {
    const meetingId = 'meeting-write-failure'
    const meetingDir = await meeting(meetingId)
    const { NotesRepository, encryptJSON } = await freshModules()
    const normal = new NotesRepository(recordingsDir)
    const initial = await normal.writeV2(meetingId, content('Initial'), {
      expectedRevision: null,
      ...sourceBindings(meetingId)
    })
    const before = await fsp.readFile(path.join(meetingDir, 'notes.json'))
    let fail = true
    const repository = new NotesRepository(recordingsDir, async (data, filePath) => {
      if (fail) {
        fail = false
        throw new Error('private filesystem failure')
      }
      await encryptJSON(data, filePath)
    })

    await expectCode(
      repository.writeV2(meetingId, content('Rejected'), {
        expectedRevision: initial.revision,
        ...sourceBindings(meetingId)
      }),
      'STORAGE_ERROR'
    )
    expect((await fsp.readFile(path.join(meetingDir, 'notes.json'))).equals(before)).toBe(true)
    await expect(
      repository.writeV2(meetingId, content('Recovered'), {
        expectedRevision: initial.revision,
        ...sourceBindings(meetingId)
      })
    ).resolves.toMatchObject({ overview: { text: 'Recovered' } })
  })

  it('promotes only the expected canonical legacy revision and never mutates legacy bytes', async () => {
    const meetingId = 'meeting-promotion'
    const meetingDir = await meeting(meetingId)
    await fsp.writeFile(
      path.join(meetingDir, 'segments.json'),
      JSON.stringify(legacy(meetingId), null, 2)
    )
    const { NotesRepository } = await freshModules()
    const repository = new NotesRepository(recordingsDir)
    const originalLegacyBytes = await fsp.readFile(path.join(meetingDir, 'segments.json'))

    await expectCode(
      repository.writeV2(meetingId, content('Bypassed promotion'), {
        expectedRevision: null,
        ...sourceBindings(meetingId)
      }),
      'REVISION_CONFLICT'
    )
    expect(
      (await fsp.readFile(path.join(meetingDir, 'segments.json'))).equals(originalLegacyBytes)
    ).toBe(true)
    await expect(fsp.access(path.join(meetingDir, 'notes.json'))).rejects.toThrow()

    const staleLegacy = await repository.adaptLegacy(meetingId)
    const changedLegacy = legacy(meetingId)
    changedLegacy.decisions[0].content = 'Changed after the generation snapshot'
    await fsp.writeFile(path.join(meetingDir, 'segments.json'), JSON.stringify(changedLegacy))

    await expectCode(
      repository.promoteLegacyToV2(meetingId, content('Stale'), {
        expectedLegacyRevision: staleLegacy.revision as `legacy-sha256:${string}`,
        ...sourceBindings(meetingId)
      }),
      'REVISION_CONFLICT'
    )
    await expect(fsp.access(path.join(meetingDir, 'notes.json'))).rejects.toThrow()

    const currentLegacy = await repository.adaptLegacy(meetingId)
    const before = await fsp.readFile(path.join(meetingDir, 'segments.json'))

    await expect(
      repository.promoteLegacyToV2(meetingId, content('Promoted'), {
        expectedLegacyRevision: currentLegacy.revision as `legacy-sha256:${string}`,
        ...sourceBindings(meetingId)
      })
    ).resolves.toMatchObject({ overview: { text: 'Promoted' } })
    expect((await fsp.readFile(path.join(meetingDir, 'segments.json'))).equals(before)).toBe(true)
    await expectCode(
      repository.promoteLegacyToV2(meetingId, content(), {
        expectedLegacyRevision: currentLegacy.revision as `legacy-sha256:${string}`,
        ...sourceBindings(meetingId)
      }),
      'REVISION_CONFLICT'
    )
  })

  it('serializes live legacy writes with promotion in both queue orders', async () => {
    const meetingId = 'meeting-live-legacy-write'
    const meetingDir = await meeting(meetingId)
    await fsp.writeFile(path.join(meetingDir, 'segments.json'), JSON.stringify(legacy(meetingId)))
    const { NotesRepository } = await freshModules()
    const { SegmentationService } = await import('../segmentation')
    const repository = new NotesRepository(recordingsDir)
    const segmentation = new SegmentationService(
      {} as never,
      { waitUntilReady: async () => {} } as never,
      recordingsDir
    )
    const staleLegacy = await repository.adaptLegacy(meetingId)
    const changedLegacy = legacy(meetingId)
    changedLegacy.decisions[0].content = 'Published before promotion'

    const legacyFirst = segmentation.saveSegments(meetingId, changedLegacy)
    const stalePromotion = repository.promoteLegacyToV2(meetingId, content('Stale'), {
      expectedLegacyRevision: staleLegacy.revision as `legacy-sha256:${string}`,
      ...sourceBindings(meetingId)
    })
    await legacyFirst
    await expectCode(stalePromotion, 'REVISION_CONFLICT')
    await expect(fsp.access(path.join(meetingDir, 'notes.json'))).rejects.toThrow()

    const currentLegacy = await repository.adaptLegacy(meetingId)
    const legacyBytes = await fsp.readFile(path.join(meetingDir, 'segments.json'))
    const v2First = repository.promoteLegacyToV2(meetingId, content('Authoritative'), {
      expectedLegacyRevision: currentLegacy.revision as `legacy-sha256:${string}`,
      ...sourceBindings(meetingId)
    })
    const lateLegacy = legacy(meetingId)
    lateLegacy.decisions[0].content = 'Must not publish beneath V2'
    const lateWrite = segmentation.saveSegments(meetingId, lateLegacy)

    await expect(v2First).resolves.toMatchObject({ overview: { text: 'Authoritative' } })
    await expect(lateWrite).resolves.toBeUndefined()
    expect((await fsp.readFile(path.join(meetingDir, 'segments.json'))).equals(legacyBytes)).toBe(
      true
    )
  })

  it('serializes ordinary V2 creation with live legacy writes in both queue orders', async () => {
    const legacyFirstId = 'meeting-create-legacy-first'
    const v2FirstId = 'meeting-create-v2-first'
    const legacyFirstDir = await meeting(legacyFirstId)
    const v2FirstDir = await meeting(v2FirstId)
    const { NotesRepository } = await freshModules()
    const { SegmentationService } = await import('../segmentation')
    const repository = new NotesRepository(recordingsDir)
    const segmentation = new SegmentationService(
      {} as never,
      { waitUntilReady: async () => {} } as never,
      recordingsDir
    )

    const legacyWrite = segmentation.saveSegments(legacyFirstId, legacy(legacyFirstId))
    const blockedCreate = repository.writeV2(legacyFirstId, content(), {
      expectedRevision: null,
      ...sourceBindings(legacyFirstId)
    })
    await legacyWrite
    await expectCode(blockedCreate, 'REVISION_CONFLICT')
    await expect(fsp.access(path.join(legacyFirstDir, 'notes.json'))).rejects.toThrow()

    const create = repository.writeV2(v2FirstId, content(), {
      expectedRevision: null,
      ...sourceBindings(v2FirstId)
    })
    const skippedLegacy = segmentation.saveSegments(v2FirstId, legacy(v2FirstId))
    await expect(create).resolves.toMatchObject({ meetingId: v2FirstId })
    await expect(skippedLegacy).resolves.toBeUndefined()
    await expect(fsp.access(path.join(v2FirstDir, 'segments.json'))).rejects.toThrow()
  })

  it('snapshots legacy promotion options before waiting on the meeting queue', async () => {
    const meetingId = 'meeting-promotion-options'
    const meetingDir = await meeting(meetingId)
    await fsp.writeFile(path.join(meetingDir, 'segments.json'), JSON.stringify(legacy(meetingId)))
    const { NotesRepository, encryptJSON } = await freshModules()
    const baseline = await new NotesRepository(recordingsDir).adaptLegacy(meetingId)
    let releaseFirstWrite!: () => void
    let markFirstWriteEntered!: () => void
    const firstWriteEntered = new Promise<void>((resolve) => {
      markFirstWriteEntered = resolve
    })
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let writeCount = 0
    const repository = new NotesRepository(recordingsDir, async (data, filePath) => {
      writeCount += 1
      if (writeCount === 1) {
        markFirstWriteEntered()
        await firstWriteGate
        throw new Error('injected first write failure')
      }
      await encryptJSON(data, filePath)
    })
    const blockedWrite = repository.promoteLegacyToV2(meetingId, content('Blocked'), {
      expectedLegacyRevision: baseline.revision as `legacy-sha256:${string}`,
      ...sourceBindings(meetingId)
    })
    await firstWriteEntered

    const originalSourceRevision = sourceRevision(meetingId)
    const originalAttributionRevision = attributionRevision(meetingId)
    const options = {
      expectedLegacyRevision: baseline.revision as `legacy-sha256:${string}`,
      sourceTranscriptRevision: originalSourceRevision,
      sourceAttributionRevision: originalAttributionRevision
    }
    const promotion = repository.promoteLegacyToV2(meetingId, content('Promoted snapshot'), options)
    options.expectedLegacyRevision = `legacy-sha256:${'0'.repeat(64)}`
    options.sourceTranscriptRevision = computeTranscriptRevision(meetingId, [
      { startMs: 10, text: 'mutated caller option' }
    ])
    options.sourceAttributionRevision = computeNotesAttributionRevision(meetingId, [
      { id: 'speaker-1', confirmedSpeakerLabel: 'Mutated' }
    ])
    releaseFirstWrite()

    await expectCode(blockedWrite, 'STORAGE_ERROR')
    await expect(promotion).resolves.toMatchObject({
      sourceTranscriptRevision: originalSourceRevision,
      sourceAttributionRevision: originalAttributionRevision,
      overview: { text: 'Promoted snapshot' }
    })
  })

  it('rejects unsafe paths, symlinked notes, and oversized entries', async () => {
    const { NotesRepository } = await freshModules()
    const repository = new NotesRepository(recordingsDir)
    await expectCode(repository.read('../escape'), 'INVALID_MEETING_ID')

    const outside = await meeting('outside')
    await fsp.symlink(
      outside,
      path.join(recordingsDir, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expectCode(repository.read('linked'), 'UNSAFE_STORAGE_ENTRY')

    if (process.platform !== 'win32') {
      const fileLinkDir = await meeting('file-link')
      const outsideFile = path.join(root, 'outside-notes.json')
      await fsp.writeFile(outsideFile, '{}')
      await fsp.symlink(outsideFile, path.join(fileLinkDir, 'notes.json'))
      await expectCode(repository.readV2('file-link'), 'UNSAFE_STORAGE_ENTRY')
    }

    const oversizedDir = await meeting('oversized')
    const oversizedPath = path.join(oversizedDir, 'notes.json')
    await fsp.writeFile(oversizedPath, '')
    await fsp.truncate(oversizedPath, NOTES_ENCRYPTED_MAX_BYTES + 1)
    await expectCode(repository.readV2('oversized'), 'NOTES_TOO_LARGE')
  })

  it.runIf(process.platform !== 'win32')(
    'revalidates the meeting directory immediately before replacing V2',
    async () => {
      const meetingId = 'meeting-directory-swap'
      const meetingDir = await meeting(meetingId)
      const displacedDir = path.join(root, 'displaced-meeting')
      const outsideDir = path.join(root, 'outside-target')
      await fsp.mkdir(outsideDir)
      const { NotesRepository, encryptJSON } = await freshModules()
      const repository = new NotesRepository(
        recordingsDir,
        async (data, filePath, beforeReplace) => {
          await fsp.rename(meetingDir, displacedDir)
          await fsp.symlink(outsideDir, meetingDir, 'dir')
          await beforeReplace?.()
          await encryptJSON(data, filePath)
        }
      )

      await expectCode(
        repository.writeV2(meetingId, content(), {
          expectedRevision: null,
          ...sourceBindings(meetingId)
        }),
        'UNSAFE_STORAGE_ENTRY'
      )
      await expect(fsp.access(path.join(outsideDir, 'notes.json'))).rejects.toThrow()
      await expect(fsp.access(path.join(displacedDir, 'notes.json'))).rejects.toThrow()
    }
  )

  it('case-folds Windows and default macOS write queue aliases', async () => {
    const { createNotesWriteQueueKey } = await freshModules()
    const base = path.join(root, 'Recordings')

    expect(createNotesWriteQueueKey(base, 'Meeting-A', 'win32')).toBe(
      createNotesWriteQueueKey(base.toUpperCase(), 'meeting-a', 'win32')
    )
    expect(createNotesWriteQueueKey(base, 'Meeting-A', 'darwin')).toBe(
      createNotesWriteQueueKey(base.toUpperCase(), 'meeting-a', 'darwin')
    )
    expect(createNotesWriteQueueKey(`${base}/Café`, 'Meeting-A', 'darwin')).toBe(
      createNotesWriteQueueKey(`${base}/Café`, 'meeting-a', 'darwin')
    )
    expect(createNotesWriteQueueKey(base, 'Meeting-A', 'linux')).not.toBe(
      createNotesWriteQueueKey(base.toUpperCase(), 'meeting-a', 'linux')
    )
  })

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'serializes live case aliases on a case-insensitive platform',
    async () => {
      const { enqueueMeetingNotesWrite } = await import('../meeting-notes-write-queue')
      const base = path.join(root, 'Recordings')
      let releaseFirst!: () => void
      let markFirstEntered!: () => void
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const firstEntered = new Promise<void>((resolve) => {
        markFirstEntered = resolve
      })
      const first = enqueueMeetingNotesWrite(base, 'Meeting-A', async () => {
        markFirstEntered()
        await firstGate
      })
      await firstEntered
      let secondStarted = false
      const second = enqueueMeetingNotesWrite(base.toUpperCase(), 'meeting-a', async () => {
        secondStarted = true
      })

      await Promise.resolve()
      expect(secondStarted).toBe(false)
      releaseFirst()
      await Promise.all([first, second])
      expect(secondStarted).toBe(true)
    }
  )
})
