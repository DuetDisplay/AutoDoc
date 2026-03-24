import { BrowserWindow } from 'electron'
import { access, readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import type { MeetingSegments, Transcript, SegmentationStatus } from '../../shared/types'
import type { LLMProvider } from './llm'
import type { OllamaManager } from './ollama-manager'

export class SegmentationService {
  private queue: string[] = []
  private activeJobId: string | null = null
  private activeStatus: SegmentationStatus | null = null
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
      const data = await readFile(segmentsPath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
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
    this.broadcastStatus(meetingId, 'segmenting')

    const transcriptData = await readFile(transcriptPath, 'utf-8')
    const transcripts: Transcript[] = JSON.parse(transcriptData)

    const fullText = transcripts.map((t) => `[${t.speaker}] ${t.text}`).join('\n')

    const segments = await this.llmProvider.summarize(meetingId, fullText)

    await writeFile(segmentsPath, JSON.stringify(segments, null, 2))

    this.activeStatus = 'complete'
    this.broadcastStatus(meetingId, 'complete')
  }

  private async markFailed(meetingId: string, error: string): Promise<void> {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'segments.error')
    await writeFile(errorPath, error)
    this.broadcastStatus(meetingId, 'failed')
  }

  private broadcastStatus(meetingId: string, status: SegmentationStatus): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('segmentation:status-changed', { meetingId, status })
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
