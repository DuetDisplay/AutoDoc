import { watch, type FSWatcher } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { Transcript } from '../../shared/types'
import { decryptJSON, isEncrypted } from './crypto'
import { readMetadata } from './calendar-matcher'
import { meetingSegmentsFromDisk } from './writer-catalog'
import { buildRecordingTitle, getRecordingDisplayCalendarTitle } from './recording-title'
import { getMainUiLanguage } from './ui-locale'
import { askAiOption } from './ask-ai-policy'
import {
  collectNotesV2SearchEntries,
  matchNotesV2SearchEntries,
  type NotesV2SearchEntry
} from './notes-search-text'

export interface IndexedTranscriptChunk {
  id: string
  startMs: number
  endMs: number
  text: string
}

export interface IndexedMeeting {
  meetingId: string
  title: string
  date: number
  dir: string
  sourceName: string | null
  noteEntries: NotesV2SearchEntry[]
  transcriptChunks: IndexedTranscriptChunk[]
  signature: string
}

export interface MeetingIndexHit {
  meetingId: string
  title: string
  date: number
  matches: Array<{
    type: 'transcript' | 'segment'
    text: string
    category?: string
    startMs?: number
  }>
}

export interface MeetingInventoryItem {
  meetingId: string
  title: string
  date: number
  sourceName: string | null
  hasNotes: boolean
  hasTranscript: boolean
}

interface MeetingIndexOptions {
  includeTranscripts?: boolean
}

const TRANSCRIPT_CHUNK_CHARS = 1_200

export class MeetingIndexService {
  private meetings = new Map<string, IndexedMeeting>()
  private inventorySnapshot: MeetingInventoryItem[] | null = null
  private titleLanguage = getMainUiLanguage()
  private loaded = false
  private dirty = true
  private refreshPromise: Promise<void> | null = null
  private watcher: FSWatcher | null = null
  private readonly incremental =
    askAiOption('AUTODOC_ASK_AI_INDEX', 'incremental', 'scan') === 'incremental'

  constructor(
    private recordingsBaseDir: string,
    private options: MeetingIndexOptions = {}
  ) {
    if (this.incremental) {
      try {
        this.watcher = watch(recordingsBaseDir, { recursive: true }, () => {
          this.dirty = true
          this.inventorySnapshot = null
        })
        this.watcher.on('error', () => {
          this.watcher?.close()
          this.watcher = null
          this.dirty = true
        })
        this.watcher.unref()
      } catch {
        /* Unsupported watcher uses the existing scan path. */
      }
    }
  }

  invalidate(meetingId?: string): void {
    this.dirty = true
    this.inventorySnapshot = null
    if (meetingId) {
      this.meetings.delete(meetingId)
      return
    }
    this.meetings.clear()
  }

  async query(query: string): Promise<MeetingIndexHit[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    await this.ensureLoaded()

    const hits: MeetingIndexHit[] = []
    for (const meeting of this.meetings.values()) {
      const matches: MeetingIndexHit['matches'] = matchNotesV2SearchEntries(
        meeting.noteEntries,
        terms
      )
      for (const chunk of meeting.transcriptChunks) {
        const lower = chunk.text.toLowerCase()
        if (terms.every((term) => lower.includes(term))) {
          matches.push({
            type: 'transcript',
            text: chunk.text,
            startMs: chunk.startMs
          })
        }
      }
      if (matches.length === 0) continue
      hits.push({
        meetingId: meeting.meetingId,
        title: meeting.title,
        date: meeting.date,
        matches: matches.slice(0, 5)
      })
    }

    return hits.sort((a, b) => b.date - a.date)
  }

  async listMeetings(): Promise<IndexedMeeting[]> {
    await this.ensureLoaded()
    return [...this.meetings.values()].sort((a, b) => b.date - a.date)
  }

  async listInventory(): Promise<MeetingInventoryItem[]> {
    await this.ensureLoaded()
    if (this.incremental && this.watcher && this.inventorySnapshot)
      return [...this.inventorySnapshot]
    let dirs: string[]
    try {
      dirs = await readdir(this.recordingsBaseDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const items: MeetingInventoryItem[] = []
    await Promise.all(
      dirs.map(async (meetingId) => {
        const meetingDir = join(this.recordingsBaseDir, meetingId)
        const dirStat = await stat(meetingDir).catch(() => null)
        if (!dirStat?.isDirectory()) return
        const loaded = this.meetings.get(meetingId)
        if (loaded) {
          items.push({
            meetingId: loaded.meetingId,
            title: loaded.title,
            date: loaded.date,
            sourceName: loaded.sourceName,
            hasNotes: loaded.noteEntries.length > 0,
            hasTranscript: loaded.transcriptChunks.length > 0
          })
          return
        }
        const metadata = await readMetadata(meetingDir).catch(() => null)
        const createdAt = metadata
          ? new Date(metadata.startedAt)
          : ((await stat(join(meetingDir, 'mic.webm')).catch(() => null))?.birthtime ??
            dirStat.birthtime)
        items.push({
          meetingId,
          title: buildRecordingTitle(
            metadata,
            createdAt.getTime(),
            getRecordingDisplayCalendarTitle(metadata, null)
          ),
          date: createdAt.getTime(),
          sourceName: metadata?.sourceName ?? null,
          hasNotes: false,
          hasTranscript: false
        })
      })
    )
    const sorted = items.sort((a, b) => b.date - a.date)
    if (this.incremental && this.watcher) this.inventorySnapshot = sorted
    return [...sorted]
  }

  async getMeeting(meetingId: string): Promise<IndexedMeeting | null> {
    this.invalidateTitleLanguage()
    const cached = this.meetings.get(meetingId)
    if (cached) return cached
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const dirStat = await stat(meetingDir).catch(() => null)
    if (!dirStat?.isDirectory()) return null
    const loaded = await this.loadMeeting(meetingId, meetingDir)
    if (loaded) this.meetings.set(meetingId, loaded)
    return loaded
  }

  private invalidateTitleLanguage(): void {
    const language = getMainUiLanguage()
    if (language === this.titleLanguage) return
    this.titleLanguage = language
    this.invalidate()
  }

  async ensureLoaded(): Promise<void> {
    if (this.refreshPromise) await this.refreshPromise
    this.invalidateTitleLanguage()
    if (this.incremental && this.watcher && this.loaded && !this.dirty) return
    this.dirty = false
    this.inventorySnapshot = null
    this.refreshPromise = this.refreshFromDisk()
    try {
      await this.refreshPromise
      this.loaded = true
    } finally {
      this.refreshPromise = null
    }
  }

  private async refreshFromDisk(): Promise<void> {
    let dirs: string[]
    try {
      dirs = await readdir(this.recordingsBaseDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.meetings.clear()
      return
    }

    const seen = new Set<string>()
    await Promise.all(
      dirs.map(async (meetingId) => {
        const meetingDir = join(this.recordingsBaseDir, meetingId)
        const dirStat = await stat(meetingDir).catch(() => null)
        if (!dirStat?.isDirectory()) return
        seen.add(meetingId)
        const loaded = await this.loadMeeting(meetingId, meetingDir)
        if (loaded) this.meetings.set(meetingId, loaded)
        else this.meetings.delete(meetingId)
      })
    )
    for (const meetingId of this.meetings.keys()) {
      if (!seen.has(meetingId)) this.meetings.delete(meetingId)
    }
  }

  private async loadMeeting(meetingId: string, meetingDir: string): Promise<IndexedMeeting | null> {
    const notesPath = join(meetingDir, 'notes.json')
    const transcriptPath = join(meetingDir, 'transcript.json')
    const notesStat = await stat(notesPath).catch(() => null)
    const transcriptStat = await stat(transcriptPath).catch(() => null)
    const [metadataStat, segmentsStat] = await Promise.all([
      stat(join(meetingDir, 'metadata.json')).catch(() => null),
      stat(join(meetingDir, 'segments.json')).catch(() => null)
    ])
    const signature = `${getMainUiLanguage()}:${notesStat?.mtimeMs ?? 0}:${transcriptStat?.mtimeMs ?? 0}:${metadataStat?.mtimeMs ?? 0}:${segmentsStat?.mtimeMs ?? 0}`
    const cached = this.meetings.get(meetingId)
    if (cached?.signature === signature) return cached

    const metadata = await readMetadata(meetingDir).catch(() => null)
    const createdAt = metadata
      ? new Date(metadata.startedAt)
      : ((await stat(join(meetingDir, 'mic.webm')).catch(() => null))?.birthtime ??
        (await stat(meetingDir)).birthtime)
    const sourceName = metadata?.sourceName ?? null
    const title = buildRecordingTitle(
      metadata,
      createdAt.getTime(),
      getRecordingDisplayCalendarTitle(metadata, null)
    )

    const v2Entries = await readNoteEntries(notesPath)
    const noteEntries = v2Entries.length > 0 ? v2Entries : await readSegmentEntries(meetingDir)
    const transcriptChunks =
      this.options.includeTranscripts === false
        ? []
        : await readTranscriptChunks(transcriptPath).catch(() => [])

    if (noteEntries.length === 0 && transcriptChunks.length === 0) return null

    return {
      meetingId,
      title,
      date: createdAt.getTime(),
      dir: meetingDir,
      sourceName,
      noteEntries,
      transcriptChunks,
      signature
    }
  }
}

async function readMaybeEncryptedJson<T>(targetPath: string): Promise<T> {
  return (await isEncrypted(targetPath))
    ? await decryptJSON<T>(targetPath)
    : JSON.parse(await readFile(targetPath, 'utf-8'))
}

async function readNoteEntries(notesPath: string): Promise<NotesV2SearchEntry[]> {
  try {
    const notes = await readMaybeEncryptedJson<unknown>(notesPath)
    return collectNotesV2SearchEntries(notes)
  } catch {
    return []
  }
}

async function readSegmentEntries(meetingDir: string): Promise<NotesV2SearchEntry[]> {
  try {
    const segments = meetingSegmentsFromDisk(
      await readMaybeEncryptedJson<unknown>(join(meetingDir, 'segments.json'))
    )
    const entries: NotesV2SearchEntry[] = []
    for (const [category, items] of Object.entries(segments)) {
      for (const item of items) {
        const content = item.content?.trim()
        if (!content) continue
        entries.push({
          id: item.id || `${category}-${entries.length}`,
          category: category as NotesV2SearchEntry['category'],
          title: item.title || category,
          content,
          topic: item.topic ?? null,
          owner: item.assignee ?? null,
          deadline: item.deadline ?? null,
          sources:
            item.sourceStartMs != null && item.sourceEndMs != null
              ? [{ startMs: item.sourceStartMs, endMs: item.sourceEndMs }]
              : []
        })
      }
    }
    return entries
  } catch {
    return []
  }
}

async function readTranscriptChunks(transcriptPath: string): Promise<IndexedTranscriptChunk[]> {
  const transcripts = await readMaybeEncryptedJson<Transcript[]>(transcriptPath)
  const chunks: IndexedTranscriptChunk[] = []
  let buffer: Transcript[] = []
  let bufferChars = 0

  const flush = (): void => {
    if (buffer.length === 0) return
    const text = buffer
      .map((item) => `${item.speaker}: ${item.text}`)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) {
      const first = buffer[0]
      const last = buffer[buffer.length - 1]
      chunks.push({
        id: `transcript-${first.startMs}-${last.endMs}`,
        startMs: first.startMs,
        endMs: last.endMs,
        text
      })
    }
    buffer = []
    bufferChars = 0
  }

  for (const transcript of transcripts) {
    const text = transcript.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (bufferChars + text.length > TRANSCRIPT_CHUNK_CHARS && buffer.length > 0) flush()
    buffer.push(transcript)
    bufferChars += text.length
    if (process.env.AUTODOC_ASK_AI_PASSAGES) flush()
  }
  flush()
  return chunks
}
