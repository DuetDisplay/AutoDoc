import { constants } from 'fs'
import { lstat, open } from 'fs/promises'
import { join } from 'path'
import type { MeetingMetadata, SpeakerMap, Transcript } from '../../shared/types'
import { decryptJSONBuffer } from './crypto'
import type { MeetingExportSnapshot } from './meeting-export'
import { NotesRepository } from './notes-repository'
import { buildRecordingTitle, getRecordingDisplayCalendarTitle } from './recording-title'

const MAX_EXPORT_JSON_BYTES = 256 * 1024 * 1024
const MAX_TRANSCRIPT_ROWS = 2_000_000
const MAX_SPEAKERS = 50_000
const MAX_STRING_LENGTH = 4 * 1024 * 1024
const ENCRYPTED_JSON_MAGIC = Buffer.from('ADOC', 'ascii')

function isNodeError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid export source data')
  }
  return value as Record<string, unknown>
}

function expectString(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) {
    throw new Error('Invalid export source data')
  }
  return value
}

function expectFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Invalid export source data')
  }
  return value
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  let beforeOpen
  try {
    beforeOpen = await lstat(filePath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }

  if (
    beforeOpen.isSymbolicLink() ||
    !beforeOpen.isFile() ||
    beforeOpen.size > MAX_EXPORT_JSON_BYTES
  ) {
    throw new Error('Unsafe export source data')
  }

  const noFollowFlag = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag)
    const afterOpen = await handle.stat()
    if (
      !afterOpen.isFile() ||
      afterOpen.size > MAX_EXPORT_JSON_BYTES ||
      afterOpen.dev !== beforeOpen.dev ||
      afterOpen.ino !== beforeOpen.ino
    ) {
      throw new Error('Unsafe export source data')
    }
    const buffer = await handle.readFile()
    if (buffer.length > MAX_EXPORT_JSON_BYTES) throw new Error('Unsafe export source data')
    return buffer.subarray(0, 4).equals(ENCRYPTED_JSON_MAGIC)
      ? decryptJSONBuffer<unknown>(buffer, filePath)
      : JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    if (isNodeError(error, 'ELOOP')) throw new Error('Unsafe export source data')
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parseTranscript(value: unknown, meetingId: string): Transcript[] {
  if (!Array.isArray(value) || value.length > MAX_TRANSCRIPT_ROWS) {
    throw new Error('Invalid transcript data')
  }

  return value.map((row) => {
    const record = expectRecord(row)
    const keys = Object.keys(record).sort()
    const expected = ['confidence', 'endMs', 'id', 'meetingId', 'speaker', 'startMs', 'text']
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new Error('Invalid transcript data')
    }

    const rowMeetingId = expectString(record.meetingId)
    const startMs = expectFiniteNumber(record.startMs)
    const endMs = expectFiniteNumber(record.endMs)
    if (rowMeetingId !== meetingId || startMs < 0 || endMs < startMs) {
      throw new Error('Invalid transcript data')
    }

    return {
      id: expectString(record.id),
      meetingId: rowMeetingId,
      speaker: expectString(record.speaker),
      text: expectString(record.text),
      startMs,
      endMs,
      confidence: expectFiniteNumber(record.confidence)
    }
  })
}

function parseSpeakers(value: unknown): SpeakerMap {
  const record = expectRecord(value)
  const entries = Object.entries(record)
  if (entries.length > MAX_SPEAKERS) throw new Error('Invalid speaker data')

  const speakers = Object.create(null) as SpeakerMap
  for (const [speakerId, rawInfo] of entries) {
    if (!speakerId || speakerId.length > MAX_STRING_LENGTH) throw new Error('Invalid speaker data')
    const info = expectRecord(rawInfo)
    const keys = Object.keys(info).sort()
    if (
      (keys.length !== 1 && keys.length !== 2) ||
      keys[0] !== 'label' ||
      (keys.length === 2 && keys[1] !== 'suggestions')
    ) {
      throw new Error('Invalid speaker data')
    }

    const suggestions = info.suggestions
    if (
      suggestions !== undefined &&
      (!Array.isArray(suggestions) || suggestions.some((item) => typeof item !== 'string'))
    ) {
      throw new Error('Invalid speaker data')
    }

    speakers[speakerId] = {
      label: expectString(info.label),
      ...(suggestions === undefined
        ? {}
        : { suggestions: suggestions.map((item) => expectString(item)) })
    }
  }
  return speakers
}

function parseMetadata(value: unknown | null): MeetingMetadata | null {
  if (value === null) return null
  const record = expectRecord(value)
  const sourceName = record.sourceName
  const startedAt = record.startedAt
  const stoppedAt = record.stoppedAt
  const durationSeconds = record.durationSeconds
  if (
    (sourceName !== null && typeof sourceName !== 'string') ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    typeof stoppedAt !== 'number' ||
    !Number.isFinite(stoppedAt) ||
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds)
  ) {
    throw new Error('Invalid meeting metadata')
  }
  const optionalString = (key: 'calendarTitle' | 'customTitle'): string | undefined => {
    const raw = record[key]
    if (raw === undefined) return undefined
    return expectString(raw)
  }
  return {
    sourceName: sourceName === null ? null : expectString(sourceName),
    startedAt,
    stoppedAt,
    durationSeconds,
    calendarTitle: optionalString('calendarTitle'),
    customTitle: optionalString('customTitle')
  }
}

export async function loadMeetingExportSnapshot(
  recordingsBaseDir: string,
  meetingId: string
): Promise<MeetingExportSnapshot> {
  // This strict repository read is deliberately first: it validates the meeting
  // identifier and rejects unsafe directory entries before any other path is joined.
  const notes = await new NotesRepository(recordingsBaseDir).read(meetingId)
  const meetingDir = join(recordingsBaseDir, meetingId)
  const meetingBefore = await lstat(meetingDir)
  if (meetingBefore.isSymbolicLink() || !meetingBefore.isDirectory()) {
    throw new Error('Unsafe meeting directory')
  }

  const [transcriptValue, speakersValue, metadataValue] = await Promise.all([
    readOptionalJson(join(meetingDir, 'transcript.json')),
    readOptionalJson(join(meetingDir, 'speakers.json')),
    readOptionalJson(join(meetingDir, 'metadata.json'))
  ])

  const meetingAfter = await lstat(meetingDir)
  if (
    meetingAfter.isSymbolicLink() ||
    !meetingAfter.isDirectory() ||
    meetingAfter.dev !== meetingBefore.dev ||
    meetingAfter.ino !== meetingBefore.ino ||
    (Number.isFinite(meetingBefore.birthtimeMs) &&
      meetingAfter.birthtimeMs !== meetingBefore.birthtimeMs)
  ) {
    throw new Error('Unsafe meeting directory')
  }

  const transcript = transcriptValue === null ? [] : parseTranscript(transcriptValue, meetingId)
  const speakers = speakersValue === null ? {} : parseSpeakers(speakersValue)
  const metadata = parseMetadata(metadataValue)
  const date = metadata?.startedAt ?? meetingBefore.birthtimeMs
  const calendarTitle = getRecordingDisplayCalendarTitle(metadata, null)

  return {
    detail: {
      title: buildRecordingTitle(metadata, date, calendarTitle),
      sourceName: calendarTitle ?? metadata?.sourceName ?? null,
      date,
      durationSeconds: metadata?.durationSeconds ?? null
    },
    notes,
    transcript,
    speakers
  }
}
