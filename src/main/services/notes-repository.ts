import { constants } from 'fs'
import { lstat, open } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { randomUUID } from 'node:crypto'
import { NOTES_ENGINE_VERSION } from '../../shared/notes-feedback'
import type {
  LegacyNotesRevision,
  MeetingNotesContent,
  MeetingNotesV2,
  NotesAttributionRevision,
  NoteBlockProvenance,
  NormalizedNoteItem,
  NormalizedNotes,
  NoteItem,
  NoteSection,
  NotesRevision,
  TranscriptRevision
} from '../../shared/types'
import { decryptJSONBuffer, encryptJSON, EncryptionKeyUnavailableError } from './crypto'
import { adaptLegacySegments, LegacySegmentsAdapterError } from './legacy-segments-adapter'
import {
  isNotesRevision,
  isNotesAttributionRevision,
  isTranscriptRevision,
  NOTES_ENCRYPTED_MAX_BYTES,
  NOTES_JSON_MAX_BYTES,
  NOTES_MEETING_ID_MAX_LENGTH,
  NotesSchemaError,
  parseMeetingNotesContent,
  parseMeetingNotesV2
} from './notes-schema'
import { computeNotesRevision } from './notes-revision'
import { enqueueMeetingNotesWrite } from './meeting-notes-write-queue'

export { createMeetingNotesWriteQueueKey as createNotesWriteQueueKey } from './meeting-notes-write-queue'

const ENCRYPTED_MAGIC = Buffer.from('ADOC', 'ascii')
const NOTES_FILENAME = 'notes.json'
const LEGACY_FILENAME = 'segments.json'

interface MeetingDirectoryIdentity {
  dev: number
  ino: number
  birthtimeMs: number
}

interface ResolvedMeetingDirectory {
  path: string
  identity: MeetingDirectoryIdentity
}

export type NotesRepositoryErrorCode =
  | 'INVALID_MEETING_ID'
  | 'MEETING_DIRECTORY_MISSING'
  | 'UNSAFE_STORAGE_ENTRY'
  | 'NOTES_TOO_LARGE'
  | 'INVALID_NOTES'
  | 'INVALID_LEGACY_NOTES'
  | 'LEGACY_NOTES_MISSING'
  | 'REVISION_CONFLICT'
  | 'STORAGE_ERROR'

const ERROR_MESSAGES: Record<NotesRepositoryErrorCode, string> = {
  INVALID_MEETING_ID: 'The meeting identifier is invalid',
  MEETING_DIRECTORY_MISSING: 'The meeting does not exist',
  UNSAFE_STORAGE_ENTRY: 'The meeting notes storage entry is unsafe',
  NOTES_TOO_LARGE: 'The meeting notes file is too large',
  INVALID_NOTES: 'The meeting notes are invalid',
  INVALID_LEGACY_NOTES: 'The legacy meeting notes are invalid',
  LEGACY_NOTES_MISSING: 'Legacy meeting notes do not exist',
  REVISION_CONFLICT: 'The meeting notes changed before this save completed',
  STORAGE_ERROR: 'The meeting notes could not be accessed'
}

export class NotesRepositoryError extends Error {
  constructor(readonly code: NotesRepositoryErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'NotesRepositoryError'
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function assertMeetingId(meetingId: string): void {
  const windowsStem = typeof meetingId === 'string' ? meetingId.split('.', 1)[0].toUpperCase() : ''
  if (
    typeof meetingId !== 'string' ||
    meetingId.length === 0 ||
    meetingId.length > NOTES_MEETING_ID_MAX_LENGTH ||
    meetingId === '.' ||
    meetingId === '..' ||
    isAbsolute(meetingId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(meetingId) ||
    meetingId.endsWith('.') ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem)
  ) {
    throw new NotesRepositoryError('INVALID_MEETING_ID')
  }
}

function normalizeItem(item: NoteItem): NormalizedNoteItem {
  return { ...item, sources: item.sources.map((source) => ({ ...source })), legacySource: null }
}

function normalizeSection(
  section: NoteSection
): NoteSection<NoteBlockProvenance, NormalizedNoteItem> {
  return {
    ...section,
    summary: section.summary
      ? {
          text: section.summary.text,
          sources: section.summary.sources.map((source) => ({ ...source })),
          provenance: section.summary.provenance
        }
      : null,
    keyPoints: section.keyPoints.map(normalizeItem),
    supportingDetails: section.supportingDetails.map(normalizeItem)
  }
}

function normalizeV2(notes: MeetingNotesV2): NormalizedNotes {
  return {
    normalizedSchemaVersion: 1,
    meetingId: notes.meetingId,
    source: { format: 'notes-v2', schemaVersion: 2 },
    sourceTranscriptRevision: notes.sourceTranscriptRevision,
    sourceAttributionRevision: notes.sourceAttributionRevision,
    revision: notes.revision,
    overview: notes.overview
      ? {
          text: notes.overview.text,
          sources: notes.overview.sources.map((source) => ({ ...source })),
          provenance: notes.overview.provenance
        }
      : null,
    keyTakeaways: notes.keyTakeaways.map(normalizeItem),
    sections: notes.sections.map(normalizeSection),
    decisions: notes.decisions.map(normalizeItem),
    nextSteps: notes.nextSteps.map(normalizeItem)
  }
}

type WriteOptions = {
  expectedRevision: NotesRevision | null
  sourceTranscriptRevision: TranscriptRevision
  sourceAttributionRevision: NotesAttributionRevision
}
type LegacyPromotionOptions = {
  expectedLegacyRevision: LegacyNotesRevision
  sourceTranscriptRevision: TranscriptRevision
  sourceAttributionRevision: NotesAttributionRevision
}

export class NotesRepository {
  constructor(
    private readonly recordingsBaseDir: string,
    private readonly encryptNotes: typeof encryptJSON = encryptJSON
  ) {}

  async read(meetingId: string): Promise<NormalizedNotes | null> {
    assertMeetingId(meetingId)
    const meetingDir = await this.resolveMeetingDirectory(meetingId, false)
    if (!meetingDir) return null

    // The presence of V2 is authoritative. Corruption must not expose stale legacy notes.
    const v2Buffer = await this.readSafeFile(join(meetingDir.path, NOTES_FILENAME))
    if (v2Buffer) return normalizeV2(this.parseV2Buffer(v2Buffer, meetingId))

    const legacyBuffer = await this.readSafeFile(join(meetingDir.path, LEGACY_FILENAME))
    return legacyBuffer ? this.parseLegacyBuffer(legacyBuffer, meetingId) : null
  }

  async readV2(meetingId: string): Promise<MeetingNotesV2 | null> {
    assertMeetingId(meetingId)
    const meetingDir = await this.resolveMeetingDirectory(meetingId, false)
    return meetingDir ? this.readV2FromDirectory(meetingDir.path, meetingId) : null
  }

  /**
   * Encrypt a validated historical plaintext notes.json without ever accepting
   * unvalidated content. Kept on the write queue so startup migration cannot
   * replace a concurrent V2 save.
   */
  async migratePlaintextV2(meetingId: string): Promise<boolean> {
    assertMeetingId(meetingId)
    return this.enqueueWrite(meetingId, async () => {
      const meetingDir = await this.resolveMeetingDirectory(meetingId, false)
      if (!meetingDir) return false
      const initial = await this.readSafeFile(join(meetingDir.path, NOTES_FILENAME))
      if (!initial || initial.subarray(0, 4).equals(ENCRYPTED_MAGIC)) return false
      this.parseV2Buffer(initial, meetingId)

      // Validate the bytes that will actually be replaced; a separate process
      // may have changed the plaintext after the first safety check.
      const latest = await this.readSafeFile(join(meetingDir.path, NOTES_FILENAME))
      if (!latest || latest.subarray(0, 4).equals(ENCRYPTED_MAGIC)) return false
      const notes = this.parseV2Buffer(latest, meetingId)
      try {
        await this.assertMeetingDirectoryIdentity(meetingDir)
        await this.encryptNotes(notes, join(meetingDir.path, NOTES_FILENAME), () =>
          this.assertMeetingDirectoryIdentity(meetingDir)
        )
        await this.assertMeetingDirectoryIdentity(meetingDir)
      } catch (error) {
        if (error instanceof NotesRepositoryError) throw error
        throw new NotesRepositoryError('STORAGE_ERROR')
      }
      const persisted = await this.readSafeFile(join(meetingDir.path, NOTES_FILENAME))
      if (!persisted || !persisted.subarray(0, 4).equals(ENCRYPTED_MAGIC)) {
        throw new NotesRepositoryError('STORAGE_ERROR')
      }
      if (this.parseV2Buffer(persisted, meetingId).revision !== notes.revision) {
        throw new NotesRepositoryError('STORAGE_ERROR')
      }
      return true
    })
  }

  async writeV2(
    meetingId: string,
    draft: MeetingNotesContent,
    options: WriteOptions
  ): Promise<MeetingNotesV2> {
    assertMeetingId(meetingId)
    const snapshot = this.parseDraft(draft)
    const { expectedRevision, sourceTranscriptRevision, sourceAttributionRevision } =
      this.parseWriteOptions(options)

    return this.enqueueWrite(meetingId, async () => {
      const meetingDir = await this.resolveMeetingDirectory(meetingId, true)
      const current = await this.readV2FromDirectory(meetingDir.path, meetingId)
      if (!current && (await this.readSafeFile(join(meetingDir.path, LEGACY_FILENAME)))) {
        throw new NotesRepositoryError('REVISION_CONFLICT')
      }
      this.assertExpectedRevision(
        current,
        expectedRevision,
        sourceTranscriptRevision,
        sourceAttributionRevision
      )
      return this.persistV2(
        meetingDir,
        meetingId,
        snapshot,
        sourceTranscriptRevision,
        sourceAttributionRevision,
        current
      )
    })
  }

  /**
   * Creates V2 from a known legacy snapshot without mutating segments.json.
   * The legacy revision comparison happens inside the same queue as the write.
   */
  async promoteLegacyToV2(
    meetingId: string,
    draft: MeetingNotesContent,
    options: LegacyPromotionOptions
  ): Promise<MeetingNotesV2> {
    assertMeetingId(meetingId)
    const snapshot = this.parseDraft(draft)
    if (
      !options ||
      typeof options !== 'object' ||
      !/^legacy-sha256:[a-f0-9]{64}$/.test(options.expectedLegacyRevision) ||
      !isTranscriptRevision(options.sourceTranscriptRevision) ||
      !isNotesAttributionRevision(options.sourceAttributionRevision)
    ) {
      throw new NotesRepositoryError('INVALID_NOTES')
    }
    const expectedLegacyRevision = options.expectedLegacyRevision
    const sourceTranscriptRevision = options.sourceTranscriptRevision
    const sourceAttributionRevision = options.sourceAttributionRevision

    return this.enqueueWrite(meetingId, async () => {
      const meetingDir = await this.resolveMeetingDirectory(meetingId, true)
      if (await this.readV2FromDirectory(meetingDir.path, meetingId)) {
        throw new NotesRepositoryError('REVISION_CONFLICT')
      }
      const legacyBuffer = await this.readSafeFile(join(meetingDir.path, LEGACY_FILENAME))
      if (!legacyBuffer) throw new NotesRepositoryError('LEGACY_NOTES_MISSING')
      const legacy = this.parseLegacyBuffer(legacyBuffer, meetingId)
      if (legacy.revision !== expectedLegacyRevision) {
        throw new NotesRepositoryError('REVISION_CONFLICT')
      }
      return this.persistV2(
        meetingDir,
        meetingId,
        snapshot,
        sourceTranscriptRevision,
        sourceAttributionRevision,
        null
      )
    })
  }

  async hasLegacySegments(meetingId: string): Promise<boolean> {
    assertMeetingId(meetingId)
    const meetingDir = await this.resolveMeetingDirectory(meetingId, false)
    return (
      !!meetingDir && (await this.readSafeFile(join(meetingDir.path, LEGACY_FILENAME))) !== null
    )
  }

  async adaptLegacy(meetingId: string): Promise<NormalizedNotes> {
    assertMeetingId(meetingId)
    const meetingDir = await this.resolveMeetingDirectory(meetingId, false)
    if (!meetingDir) throw new NotesRepositoryError('LEGACY_NOTES_MISSING')
    const buffer = await this.readSafeFile(join(meetingDir.path, LEGACY_FILENAME))
    if (!buffer) throw new NotesRepositoryError('LEGACY_NOTES_MISSING')
    return this.parseLegacyBuffer(buffer, meetingId)
  }

  private parseDraft(draft: MeetingNotesContent): MeetingNotesContent {
    try {
      return parseMeetingNotesContent(draft)
    } catch {
      throw new NotesRepositoryError('INVALID_NOTES')
    }
  }

  private parseWriteOptions(options: WriteOptions): WriteOptions {
    if (
      !options ||
      typeof options !== 'object' ||
      !Object.prototype.hasOwnProperty.call(options, 'expectedRevision') ||
      (options.expectedRevision !== null && !isNotesRevision(options.expectedRevision)) ||
      !isTranscriptRevision(options.sourceTranscriptRevision) ||
      !isNotesAttributionRevision(options.sourceAttributionRevision)
    ) {
      throw new NotesRepositoryError('INVALID_NOTES')
    }
    return {
      expectedRevision: options.expectedRevision,
      sourceTranscriptRevision: options.sourceTranscriptRevision,
      sourceAttributionRevision: options.sourceAttributionRevision
    }
  }

  private assertExpectedRevision(
    current: MeetingNotesV2 | null,
    expectedRevision: NotesRevision | null,
    sourceTranscriptRevision: TranscriptRevision,
    sourceAttributionRevision: NotesAttributionRevision
  ): void {
    if (
      (current === null && expectedRevision !== null) ||
      (current !== null &&
        (current.revision !== expectedRevision ||
          current.sourceTranscriptRevision !== sourceTranscriptRevision ||
          current.sourceAttributionRevision !== sourceAttributionRevision))
    ) {
      throw new NotesRepositoryError('REVISION_CONFLICT')
    }
  }

  private async persistV2(
    meetingDir: ResolvedMeetingDirectory,
    meetingId: string,
    content: MeetingNotesContent,
    sourceTranscriptRevision: TranscriptRevision,
    sourceAttributionRevision: NotesAttributionRevision,
    current: MeetingNotesV2 | null
  ): Promise<MeetingNotesV2> {
    await this.assertMeetingDirectoryIdentity(meetingDir)
    const revision = computeNotesRevision(
      meetingId,
      sourceTranscriptRevision,
      sourceAttributionRevision,
      content
    )
    if (current?.revision === revision) return current
    const notes: MeetingNotesV2 = {
      schemaVersion: 2,
      meetingId,
      sourceTranscriptRevision,
      sourceAttributionRevision,
      revision,
      ...(current
        ? current.generation
          ? { generation: current.generation }
          : {}
        : { generation: { id: randomUUID(), engineVersion: NOTES_ENGINE_VERSION } }),
      ...content
    }
    if (Buffer.byteLength(JSON.stringify(notes), 'utf8') > NOTES_JSON_MAX_BYTES) {
      throw new NotesRepositoryError('NOTES_TOO_LARGE')
    }

    try {
      await this.encryptNotes(notes, join(meetingDir.path, NOTES_FILENAME), () =>
        this.assertMeetingDirectoryIdentity(meetingDir)
      )
      await this.assertMeetingDirectoryIdentity(meetingDir)
    } catch (error) {
      if (error instanceof NotesRepositoryError) throw error
      throw new NotesRepositoryError('STORAGE_ERROR')
    }

    const persistedBuffer = await this.readSafeFile(join(meetingDir.path, NOTES_FILENAME))
    if (!persistedBuffer || !persistedBuffer.subarray(0, 4).equals(ENCRYPTED_MAGIC)) {
      throw new NotesRepositoryError('STORAGE_ERROR')
    }
    const persisted = this.parseV2Buffer(persistedBuffer, meetingId)
    if (persisted.revision !== revision) throw new NotesRepositoryError('STORAGE_ERROR')
    return persisted
  }

  private enqueueWrite<T>(meetingId: string, operation: () => Promise<T>): Promise<T> {
    return enqueueMeetingNotesWrite(this.recordingsBaseDir, meetingId, operation)
  }

  private async resolveMeetingDirectory(
    meetingId: string,
    required: true
  ): Promise<ResolvedMeetingDirectory>
  private async resolveMeetingDirectory(
    meetingId: string,
    required: false
  ): Promise<ResolvedMeetingDirectory | null>
  private async resolveMeetingDirectory(
    meetingId: string,
    required: boolean
  ): Promise<ResolvedMeetingDirectory | null> {
    const baseDir = resolve(this.recordingsBaseDir)
    const meetingDir = resolve(baseDir, meetingId)
    const relativePath = relative(baseDir, meetingDir)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new NotesRepositoryError('INVALID_MEETING_ID')
    }
    try {
      const stats = await lstat(meetingDir)
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new NotesRepositoryError('UNSAFE_STORAGE_ENTRY')
      }
      return {
        path: meetingDir,
        identity: {
          dev: stats.dev,
          ino: stats.ino,
          birthtimeMs: stats.birthtimeMs
        }
      }
    } catch (error) {
      if (error instanceof NotesRepositoryError) throw error
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        if (required) throw new NotesRepositoryError('MEETING_DIRECTORY_MISSING')
        return null
      }
      throw new NotesRepositoryError('STORAGE_ERROR')
    }
  }

  private async assertMeetingDirectoryIdentity(
    meetingDir: ResolvedMeetingDirectory
  ): Promise<void> {
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(meetingDir.path)
    } catch {
      throw new NotesRepositoryError('UNSAFE_STORAGE_ENTRY')
    }
    const { identity } = meetingDir
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      stats.dev !== identity.dev ||
      stats.ino !== identity.ino ||
      (Number.isFinite(identity.birthtimeMs) && stats.birthtimeMs !== identity.birthtimeMs)
    ) {
      throw new NotesRepositoryError('UNSAFE_STORAGE_ENTRY')
    }
  }

  private async readSafeFile(filePath: string): Promise<Buffer | null> {
    let beforeOpen: Awaited<ReturnType<typeof lstat>>
    try {
      beforeOpen = await lstat(filePath)
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) return null
      throw new NotesRepositoryError('STORAGE_ERROR')
    }
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
      throw new NotesRepositoryError('UNSAFE_STORAGE_ENTRY')
    }
    if (beforeOpen.size > NOTES_ENCRYPTED_MAX_BYTES) {
      throw new NotesRepositoryError('NOTES_TOO_LARGE')
    }

    const noFollowFlag = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(filePath, constants.O_RDONLY | noFollowFlag)
      const afterOpen = await handle.stat()
      if (
        !afterOpen.isFile() ||
        afterOpen.size > NOTES_ENCRYPTED_MAX_BYTES ||
        afterOpen.dev !== beforeOpen.dev ||
        afterOpen.ino !== beforeOpen.ino
      ) {
        throw new NotesRepositoryError(
          afterOpen.size > NOTES_ENCRYPTED_MAX_BYTES ? 'NOTES_TOO_LARGE' : 'UNSAFE_STORAGE_ENTRY'
        )
      }
      const buffer = await handle.readFile()
      if (buffer.length > NOTES_ENCRYPTED_MAX_BYTES)
        throw new NotesRepositoryError('NOTES_TOO_LARGE')
      return buffer
    } catch (error) {
      if (error instanceof NotesRepositoryError) throw error
      if (isNodeErrorWithCode(error, 'ELOOP'))
        throw new NotesRepositoryError('UNSAFE_STORAGE_ENTRY')
      throw new NotesRepositoryError('STORAGE_ERROR')
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  private parseJsonBuffer(buffer: Buffer, filename: string): unknown {
    const encrypted = buffer.length >= 4 && buffer.subarray(0, 4).equals(ENCRYPTED_MAGIC)
    if (!encrypted && buffer.length > NOTES_JSON_MAX_BYTES) {
      throw new NotesRepositoryError('NOTES_TOO_LARGE')
    }
    try {
      return encrypted
        ? decryptJSONBuffer<unknown>(buffer, filename)
        : JSON.parse(buffer.toString('utf8'))
    } catch (error) {
      if (error instanceof EncryptionKeyUnavailableError)
        throw new NotesRepositoryError('STORAGE_ERROR')
      throw new NotesRepositoryError('INVALID_NOTES')
    }
  }

  private parseV2Buffer(buffer: Buffer, meetingId: string): MeetingNotesV2 {
    try {
      return parseMeetingNotesV2(this.parseJsonBuffer(buffer, NOTES_FILENAME), meetingId)
    } catch (error) {
      if (error instanceof NotesRepositoryError) throw error
      if (error instanceof NotesSchemaError) throw new NotesRepositoryError('INVALID_NOTES')
      throw new NotesRepositoryError('INVALID_NOTES')
    }
  }

  private parseLegacyBuffer(buffer: Buffer, meetingId: string): NormalizedNotes {
    let value: unknown
    try {
      value = this.parseJsonBuffer(buffer, LEGACY_FILENAME)
    } catch (error) {
      if (error instanceof NotesRepositoryError && error.code !== 'INVALID_NOTES') throw error
      throw new NotesRepositoryError('INVALID_LEGACY_NOTES')
    }

    try {
      return adaptLegacySegments(meetingId, value)
    } catch (error) {
      if (error instanceof LegacySegmentsAdapterError)
        throw new NotesRepositoryError('INVALID_LEGACY_NOTES')
      throw new NotesRepositoryError('INVALID_LEGACY_NOTES')
    }
  }

  private async readV2FromDirectory(
    meetingDir: string,
    meetingId: string
  ): Promise<MeetingNotesV2 | null> {
    const buffer = await this.readSafeFile(join(meetingDir, NOTES_FILENAME))
    return buffer ? this.parseV2Buffer(buffer, meetingId) : null
  }
}
