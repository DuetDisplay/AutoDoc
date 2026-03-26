import { BrowserWindow } from 'electron'
import { access, readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import type { Transcript, TranscriptionStatus, SpeakerMap } from '../../shared/types'
import type { WhisperManager } from './whisper-manager'
import type { AudioConverter } from './audio-converter'
import { alignSpeakers } from './speaker-alignment'
import { matchCalendarEvent, readMetadata } from './calendar-matcher'
import { encryptJSON, decryptJSON, decryptFileToTemp, isEncrypted, encryptFileInPlace } from './crypto'
import type { CalendarService } from './calendar'

interface WhisperSegment {
  offsets: { from: number; to: number }
  text: string
}

interface WhisperOutput {
  transcription: WhisperSegment[]
}

export class TranscriptionService {
  private queue: string[] = []
  private activeJobId: string | null = null
  private activeStatus: TranscriptionStatus | null = null
  private processing = false
  private onCompleteCallback: ((meetingId: string) => void) | null = null

  constructor(
    private whisperManager: WhisperManager,
    private audioConverter: AudioConverter,
    private recordingsBaseDir: string,
    private calendarService: CalendarService,
  ) {}

  onComplete(callback: (meetingId: string) => void): void {
    this.onCompleteCallback = callback
  }

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
      if (await isEncrypted(transcriptPath)) {
        return await decryptJSON<Transcript[]>(transcriptPath)
      }
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
      const micPath = join(meetingDir, 'mic.webm')
      const transcriptPath = join(meetingDir, 'transcript.json')
      const errorPath = join(meetingDir, 'transcript.error')

      const hasAudio = await this.fileExists(audioPath) || await this.fileExists(micPath)
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
    const transcriptPath = join(meetingDir, 'transcript.json')

    const micWebm = join(meetingDir, 'mic.webm')
    const systemWebm = join(meetingDir, 'system.webm')
    const legacyAudio = join(meetingDir, 'audio.webm')

    const hasMic = await this.fileExists(micWebm)
    const hasSystem = await this.fileExists(systemWebm)
    const hasLegacy = await this.fileExists(legacyAudio)

    if (!hasMic && !hasLegacy) {
      return
    }

    const tempPrefix = join(tmpdir(), `autodoc-${meetingId}-${Date.now()}`)
    const tempAudioWav = `${tempPrefix}.wav`
    const tempWhisperJson = `${tempPrefix}.wav.json`
    const tempFiles: string[] = [tempAudioWav, tempWhisperJson]

    try {
      if (!(await this.whisperManager.isReady())) {
        this.activeStatus = 'downloading'
        this.broadcastStatus(meetingId, 'downloading')
        await this.whisperManager.ensureReady()
      }

      this.activeStatus = 'transcribing'
      this.broadcastStatus(meetingId, 'transcribing')

      // Prepare audio input for whisper
      const audioInput = await this.prepareWhisperInput(
        micWebm, systemWebm, legacyAudio,
        hasMic, hasSystem, hasLegacy,
        tempPrefix, tempFiles,
      )

      await this.audioConverter.convert(audioInput, tempAudioWav, this.whisperManager.getFfmpegPath())

      const audioDuration = await this.audioConverter.getDuration(
        tempAudioWav,
        this.whisperManager.getFfmpegPath()
      ).catch(() => undefined)

      await this.runWhisper(tempAudioWav, meetingId, audioDuration)

      const whisperJson = await readFile(tempWhisperJson, 'utf-8')
      const whisperOutput: WhisperOutput = JSON.parse(whisperJson)
      let transcripts = this.mapToTranscripts(meetingId, whisperOutput)

      // Speaker labeling (two-stream: system active = remote, system silent = "me")
      if (hasMic && hasSystem) {
        try {
          this.activeStatus = 'diarizing'
          this.broadcastStatus(meetingId, 'diarizing')

          // Detect system audio activity — clean digital signal, no mic bleed
          const tempSystemWav = `${tempPrefix}-system.wav`
          tempFiles.push(tempSystemWav)
          const systemInput = await this.decryptIfNeeded(systemWebm, tempFiles)
          await this.audioConverter.convert(systemInput, tempSystemWav, this.whisperManager.getFfmpegPath())
          const systemSegments = await this.detectAudioActivity(tempSystemWav)

          transcripts = alignSpeakers(transcripts, null, systemSegments)
          await this.generateSpeakersJson(meetingId, transcripts)
        } catch (err) {
          console.error('Speaker labeling failed:', err)
        }
      }

      await encryptJSON(transcripts, transcriptPath)

      // Encrypt raw media files
      for (const filename of ['mic.webm', 'system.webm', 'screen.webm']) {
        const filePath = join(meetingDir, filename)
        try {
          if ((await this.fileExists(filePath)) && !(await isEncrypted(filePath))) {
            await encryptFileInPlace(filePath)
          }
        } catch (err) {
          console.error(`Failed to encrypt ${filePath}:`, err)
        }
      }

      this.activeStatus = 'complete'
      this.broadcastStatus(meetingId, 'complete')
      this.onCompleteCallback?.(meetingId)
    } finally {
      for (const f of tempFiles) {
        await unlink(f).catch(() => {})
      }
    }
  }

  private async decryptIfNeeded(filePath: string, tempFiles: string[]): Promise<string> {
    if (await isEncrypted(filePath)) {
      const temp = await decryptFileToTemp(filePath)
      tempFiles.push(temp)
      return temp
    }
    return filePath
  }

  private async prepareWhisperInput(
    micWebm: string, systemWebm: string, legacyAudio: string,
    hasMic: boolean, hasSystem: boolean, _hasLegacy: boolean,
    tempPrefix: string, tempFiles: string[],
  ): Promise<string> {
    if (hasMic) {
      const micInput = await this.decryptIfNeeded(micWebm, tempFiles)
      if (hasSystem) {
        const systemInput = await this.decryptIfNeeded(systemWebm, tempFiles)
        const mergedPath = `${tempPrefix}-merged.webm`
        tempFiles.push(mergedPath)
        await this.audioConverter.mergeAudio(micInput, systemInput, mergedPath, this.whisperManager.getFfmpegPath())
        return mergedPath
      }
      return micInput
    }
    // Legacy single-file format
    return await this.decryptIfNeeded(legacyAudio, tempFiles)
  }

  private detectAudioActivity(wavPath: string): Promise<{ start: number; end: number }[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.whisperManager.getFfmpegPath(), [
        '-i', wavPath,
        '-af', 'silencedetect=noise=-30dB:d=0.5',
        '-f', 'null', '-',
      ])
      let stderr = ''
      proc.on('error', (err) => reject(new Error(`ffmpeg silencedetect spawn failed: ${err.message}`)))
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg silencedetect failed: ${stderr.slice(-500)}`))
          return
        }
        const silenceStarts: number[] = []
        const silenceEnds: number[] = []
        for (const match of stderr.matchAll(/silence_start:\s*([\d.]+)/g)) {
          silenceStarts.push(parseFloat(match[1]))
        }
        for (const match of stderr.matchAll(/silence_end:\s*([\d.]+)/g)) {
          silenceEnds.push(parseFloat(match[1]))
        }

        const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
        const totalDuration = durMatch
          ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]) + parseFloat('0.' + durMatch[4])
          : 0

        const active: { start: number; end: number }[] = []
        let pos = 0
        for (let i = 0; i < silenceStarts.length; i++) {
          if (silenceStarts[i] > pos) {
            active.push({ start: pos, end: silenceStarts[i] })
          }
          pos = silenceEnds[i] ?? silenceStarts[i]
        }
        if (pos < totalDuration) {
          active.push({ start: pos, end: totalDuration })
        }

        resolve(active)
      })
    })
  }

  private async generateSpeakersJson(meetingId: string, transcripts: Transcript[]): Promise<void> {
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const speakersPath = join(meetingDir, 'speakers.json')

    const speakerIds = new Set(transcripts.map((t) => t.speaker))

    let suggestions: string[] = []
    try {
      if (this.calendarService.isConnected()) {
        const metadata = await readMetadata(meetingDir)
        if (metadata?.startedAt) {
          const events = await this.calendarService.fetchRecentEvents(30)
          const matched = matchCalendarEvent(events, metadata.startedAt)
          if (matched) {
            suggestions = matched.attendees
          }
        }
      }
    } catch {
      // Calendar fetch failed
    }

    const speakerMap: SpeakerMap = {}
    let speakerNum = 0
    for (const id of speakerIds) {
      if (id === 'me') {
        speakerMap[id] = { label: 'Me' }
      } else if (id === 'them') {
        speakerMap[id] = {
          label: 'Them',
          ...(suggestions.length > 0 ? { suggestions } : {}),
        }
      } else if (id === 'Speaker') {
        // Legacy un-diarized segment, skip
        continue
      } else {
        speakerNum++
        speakerMap[id] = {
          label: `Speaker ${speakerNum}`,
          ...(suggestions.length > 0 ? { suggestions } : {}),
        }
      }
    }

    await encryptJSON(speakerMap, speakersPath)
  }

  private runWhisper(audioWavPath: string, meetingId: string, audioDurationSec?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = 30 * 60 * 1000
      let stderr = ''

      const proc = spawn(this.whisperManager.getWhisperPath(), [
        '-m', this.whisperManager.getModelPath(),
        '-f', audioWavPath,
        '-oj',
        '-l', 'en',
        '-pp',
      ])

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`whisper spawn failed: ${err.message}`))
      })

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('whisper.cpp timed out after 30 minutes'))
      }, timeout)

      proc.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        // Parse whisper.cpp progress: "whisper_print_progress_callback: progress = 42%"
        const match = chunk.match(/progress\s*=\s*(\d+)%/)
        if (match) {
          const progress = parseInt(match[1], 10)
          this.broadcastStatus(meetingId, 'transcribing', progress)
        }
      })

      // Also parse stdout timestamps for more granular progress on short recordings
      // Whisper outputs lines like: [00:01:30.000 --> 00:01:59.980]
      if (audioDurationSec && audioDurationSec > 0) {
        proc.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString()
          const tsMatch = chunk.match(/\[(\d+):(\d+):(\d+)\.\d+\s*-->/)
          if (tsMatch) {
            const h = parseInt(tsMatch[1], 10)
            const m = parseInt(tsMatch[2], 10)
            const s = parseInt(tsMatch[3], 10)
            const currentSec = h * 3600 + m * 60 + s + 30 // +30 since this segment is being completed
            const progress = Math.min(99, Math.round((currentSec / audioDurationSec) * 100))
            this.broadcastStatus(meetingId, 'transcribing', progress)
          }
        })
      }

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
    return output.transcription.map((seg, index) => ({
      id: `${meetingId}-${index}`,
      meetingId,
      speaker: 'Speaker',
      text: seg.text.trim(),
      startMs: seg.offsets.from,
      endMs: seg.offsets.to,
      confidence: -1,
    }))
  }

  private async markFailed(meetingId: string, error: string): Promise<void> {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'transcript.error')
    await writeFile(errorPath, error)
    this.broadcastStatus(meetingId, 'failed')
  }

  private broadcastStatus(meetingId: string, status: TranscriptionStatus, progress?: number): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('transcription:status-changed', { meetingId, status, progress })
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
