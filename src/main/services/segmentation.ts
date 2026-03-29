import { BrowserWindow } from 'electron'
import { access, readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import type { MeetingSegments, Transcript, SegmentationStatus } from '../../shared/types'
import type { LLMProvider } from './llm'
import type { OllamaManager } from './ollama-manager'
import { encryptJSON, decryptJSON, isEncrypted } from './crypto'

export class SegmentationService {
  private queue: string[] = []
  private activeJobId: string | null = null
  private activeStatus: SegmentationStatus | null = null
  private activeProgress: number | undefined = undefined
  private processing = false

  constructor(
    private llmProvider: LLMProvider,
    private ollamaManager: OllamaManager,
    private recordingsBaseDir: string,
  ) {}

  enqueue(meetingId: string): void {
    if (this.activeJobId === meetingId) return
    if (this.queue.includes(meetingId)) return
    this.queue.push(meetingId)
    this.broadcastStatus(meetingId, 'queued')
    this.processNext()
  }

  retry(meetingId: string): void {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'segments.error')
    unlink(errorPath).catch(() => {})
    this.enqueue(meetingId)
  }

  getProgress(meetingId: string): number | undefined {
    if (this.activeJobId === meetingId) return this.activeProgress
    return undefined
  }

  async getStatus(meetingId: string): Promise<SegmentationStatus> {
    if (this.activeJobId === meetingId && this.activeStatus) {
      return this.activeStatus
    }
    if (this.queue.includes(meetingId)) {
      return 'queued'
    }
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    if (await this.fileExists(join(meetingDir, 'segments.json'))) return 'complete'
    if (await this.fileExists(join(meetingDir, 'segments.error'))) return 'failed'
    return 'pending'
  }

  async getSegments(meetingId: string): Promise<MeetingSegments | null> {
    const segmentsPath = join(this.recordingsBaseDir, meetingId, 'segments.json')
    try {
      if (await isEncrypted(segmentsPath)) {
        return await decryptJSON<MeetingSegments>(segmentsPath)
      }
      const data = await readFile(segmentsPath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  async saveSegments(meetingId: string, segments: MeetingSegments): Promise<void> {
    const segmentsPath = join(this.recordingsBaseDir, meetingId, 'segments.json')
    await encryptJSON(segments, segmentsPath)
  }

  async scanAndEnqueuePending(): Promise<void> {
    const { readdir, stat } = await import('fs/promises')
    let dirs: string[]
    try {
      dirs = await readdir(this.recordingsBaseDir)
    } catch {
      return
    }

    for (const meetingId of dirs) {
      const meetingDir = join(this.recordingsBaseDir, meetingId)
      const dirStat = await stat(meetingDir).catch(() => null)
      if (!dirStat?.isDirectory()) continue

      const hasTranscript = await this.fileExists(join(meetingDir, 'transcript.json'))
      const hasSegments = await this.fileExists(join(meetingDir, 'segments.json'))
      const hasError = await this.fileExists(join(meetingDir, 'segments.error'))

      if (hasTranscript && !hasSegments && !hasError) {
        this.enqueue(meetingId)
      } else if (hasTranscript && !hasSegments && hasError) {
        const errorData = await this.readErrorFile(join(meetingDir, 'segments.error'))
        if (errorData && errorData.retries < 3) {
          console.log(`Auto-retrying segmentation for ${meetingId} (attempt ${errorData.retries + 1}/3)`)
          this.retry(meetingId)
        }
      }
    }
  }

  private async processNext(): Promise<void> {
    if (this.processing) return
    if (this.queue.length === 0) return

    this.processing = true
    const meetingId = this.queue.shift()!
    this.activeJobId = meetingId

    try {
      await this.processJob(meetingId)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await this.markFailed(meetingId, errorMsg)
    } finally {
      this.activeJobId = null
      this.activeStatus = null
      this.processing = false
      this.processNext()
    }
  }

  private async processJob(meetingId: string): Promise<void> {
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const transcriptPath = join(meetingDir, 'transcript.json')
    const segmentsPath = join(meetingDir, 'segments.json')

    if (!(await this.fileExists(transcriptPath))) {
      return
    }

    this.activeStatus = 'downloading-model'
    this.broadcastStatus(meetingId, 'downloading-model')
    await this.ollamaManager.waitUntilReady()

    this.activeStatus = 'segmenting'
    this.broadcastStatus(meetingId, 'segmenting', 0)

    const t0 = Date.now()

    const transcripts: Transcript[] = await isEncrypted(transcriptPath)
      ? await decryptJSON<Transcript[]>(transcriptPath)
      : JSON.parse(await readFile(transcriptPath, 'utf-8'))

    const fullText = transcripts
      .map((t) => {
        const totalSec = Math.floor(t.startMs / 1000)
        const h = Math.floor(totalSec / 3600)
        const m = Math.floor((totalSec % 3600) / 60)
        const s = totalSec % 60
        const ts = h > 0
          ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        return `[${ts}] [${t.speaker}] ${t.text}`
      })
      .join('\n')

    console.log(`[perf] Segmentation input: ${fullText.length} chars (${meetingId})`)

    // Compute actual duration from transcript timestamps
    const lastEntry = transcripts[transcripts.length - 1]
    const durationMinutes = lastEntry ? Math.round((lastEntry.endMs || lastEntry.startMs) / 60000) : undefined

    let lastBroadcastedPercent = -1
    const segments = await this.llmProvider.summarize(meetingId, fullText, (percent) => {
      if (percent !== lastBroadcastedPercent) {
        lastBroadcastedPercent = percent
        this.broadcastStatus(meetingId, 'segmenting', percent)
      }
    }, durationMinutes)

    // Verify the LLM actually produced content — empty results mean it failed silently
    const totalItems = segments.decisions.length +
      segments.actionItems.length +
      segments.information.length +
      segments.discussion.length +
      segments.statusUpdates.length

    if (totalItems === 0 && fullText.length > 100) {
      throw new Error('LLM returned empty segments for non-trivial transcript — likely context overflow or model issue')
    }

    await encryptJSON(segments, segmentsPath)

    console.log(`[perf] Segmentation total: ${((Date.now() - t0) / 1000).toFixed(1)}s (${meetingId})`)

    this.activeStatus = 'complete'
    this.broadcastStatus(meetingId, 'complete')
  }

  private async markFailed(meetingId: string, error: string): Promise<void> {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'segments.error')
    const existing = await this.readErrorFile(errorPath)
    const retries = (existing?.retries ?? 0) + 1
    await writeFile(errorPath, JSON.stringify({ error, retries }))
    this.broadcastStatus(meetingId, 'failed')
  }

  private async readErrorFile(errorPath: string): Promise<{ error: string; retries: number } | null> {
    try {
      const raw = await readFile(errorPath, 'utf-8')
      try {
        return JSON.parse(raw)
      } catch {
        return { error: raw, retries: 0 }
      }
    } catch {
      return null
    }
  }

  private broadcastStatus(meetingId: string, status: SegmentationStatus, progress?: number): void {
    this.activeProgress = progress
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('segmentation:status-changed', { meetingId, status, progress })
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }
}
