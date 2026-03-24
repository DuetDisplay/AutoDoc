import { BrowserWindow } from 'electron'
import { access, readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'child_process'
import type { Transcript, TranscriptionStatus } from '../../shared/types'
import type { WhisperManager } from './whisper-manager'
import type { AudioConverter } from './audio-converter'

interface WhisperSegment {
  t0: number
  t1: number
  text: string
}

interface WhisperOutput {
  segments: WhisperSegment[]
}

export class TranscriptionService {
  private queue: string[] = []
  private activeJobId: string | null = null
  private activeStatus: TranscriptionStatus | null = null
  private processing = false

  constructor(
    private whisperManager: WhisperManager,
    private audioConverter: AudioConverter,
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
    const errorPath = join(this.recordingsBaseDir, meetingId, 'transcript.error')
    unlink(errorPath).catch(() => {})
    this.enqueue(meetingId)
  }

  async getStatus(meetingId: string): Promise<TranscriptionStatus> {
    if (this.activeJobId === meetingId && this.activeStatus) {
      return this.activeStatus
    }
    if (this.queue.includes(meetingId)) {
      return 'queued'
    }
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    if (await this.fileExists(join(meetingDir, 'transcript.json'))) return 'complete'
    if (await this.fileExists(join(meetingDir, 'transcript.error'))) return 'failed'
    return 'pending'
  }

  async getTranscript(meetingId: string): Promise<Transcript[]> {
    const transcriptPath = join(this.recordingsBaseDir, meetingId, 'transcript.json')
    try {
      const data = await readFile(transcriptPath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return []
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

      const audioPath = join(meetingDir, 'audio.webm')
      const transcriptPath = join(meetingDir, 'transcript.json')
      const errorPath = join(meetingDir, 'transcript.error')

      const hasAudio = await this.fileExists(audioPath)
      const hasTranscript = await this.fileExists(transcriptPath)
      const hasError = await this.fileExists(errorPath)

      if (hasAudio && !hasTranscript && !hasError) {
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
    const audioWebm = join(meetingDir, 'audio.webm')
    const audioWav = join(meetingDir, 'audio.wav')
    const whisperJsonOutput = join(meetingDir, 'audio.wav.json')
    const transcriptPath = join(meetingDir, 'transcript.json')

    if (!(await this.fileExists(audioWebm))) {
      return
    }

    if (!(await this.whisperManager.isReady())) {
      this.activeStatus = 'downloading'
      this.broadcastStatus(meetingId, 'downloading')
      await this.whisperManager.ensureReady()
    }

    this.activeStatus = 'transcribing'
    this.broadcastStatus(meetingId, 'transcribing')

    await this.audioConverter.convert(
      audioWebm,
      audioWav,
      this.whisperManager.getFfmpegPath()
    )

    await this.runWhisper(audioWav)

    const whisperJson = await readFile(whisperJsonOutput, 'utf-8')
    const whisperOutput: WhisperOutput = JSON.parse(whisperJson)
    const transcripts = this.mapToTranscripts(meetingId, whisperOutput)

    await writeFile(transcriptPath, JSON.stringify(transcripts, null, 2))

    await unlink(audioWav).catch(() => {})
    await unlink(whisperJsonOutput).catch(() => {})

    this.activeStatus = 'complete'
    this.broadcastStatus(meetingId, 'complete')
  }

  private runWhisper(audioWavPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = 30 * 60 * 1000
      let stderr = ''

      const proc = spawn(this.whisperManager.getWhisperPath(), [
        '-m', this.whisperManager.getModelPath(),
        '-f', audioWavPath,
        '-oj',
        '-l', 'en',
      ])

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('whisper.cpp timed out after 30 minutes'))
      }, timeout)

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`whisper.cpp exited with code ${code}: ${stderr.slice(-500)}`))
        }
      })
    })
  }

  private mapToTranscripts(meetingId: string, output: WhisperOutput): Transcript[] {
    return output.segments.map((seg, index) => ({
      id: `${meetingId}-${index}`,
      meetingId,
      speaker: 'Speaker',
      text: seg.text.trim(),
      startMs: seg.t0 * 10,
      endMs: seg.t1 * 10,
      confidence: -1,
    }))
  }

  private async markFailed(meetingId: string, error: string): Promise<void> {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'transcript.error')
    await writeFile(errorPath, error)
    this.broadcastStatus(meetingId, 'failed')
  }

  private broadcastStatus(meetingId: string, status: TranscriptionStatus): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('transcription:status-changed', { meetingId, status })
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
