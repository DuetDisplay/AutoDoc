import { createHash, randomUUID } from 'node:crypto'
import type { MeetingNotesV2 } from '../../shared/types'
import {
  feedbackGenerationId,
  buildNotesFeedbackEvent,
  isNotesFeedbackEnvelope,
  isNotesFeedbackRating,
  NOTES_FEEDBACK_COMMENT_LIMIT,
  type NotesFeedbackRequest,
  type NotesFeedbackResult,
  type NotesFeedbackState
} from '../../shared/notes-feedback'
import type { NotesFeedbackEnvelope } from '../../shared/notes-feedback'

export interface FeedbackReceipt {
  submissionId: string
  sent: boolean
  timestamp: string
  pending?: NotesFeedbackEnvelope
}
export interface FeedbackReceiptStore {
  get(key: string): FeedbackReceipt | undefined
  set(key: string, value: FeedbackReceipt): void
}

interface Options {
  readNotes: (meetingId: string) => Promise<MeetingNotesV2 | null>
  receipts: FeedbackReceiptStore
  projectKey: string
  host: string
  appVersion: string
  platform: NodeJS.Platform
  analyticsEnabled: () => boolean
  fetch?: typeof fetch
}

function receiptKey(meetingId: string, generationId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([meetingId, generationId]))
    .digest('hex')
}

function validMeeting(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value)
}

export class NotesFeedbackService {
  private readonly pending = new Map<string, Promise<NotesFeedbackResult>>()
  constructor(private readonly options: Options) {}

  async state(meetingId: unknown, generationId: unknown): Promise<NotesFeedbackState> {
    const unavailable = {
      available: false,
      sent: false,
      analyticsEnabled: this.options.analyticsEnabled()
    }
    if (!validMeeting(meetingId) || typeof generationId !== 'string' || !this.options.projectKey)
      return unavailable
    try {
      const notes = await this.options.readNotes(meetingId)
      if (!notes || feedbackGenerationId(notes) !== generationId) return unavailable
      const receipt = this.options.receipts.get(receiptKey(meetingId, generationId))
      return {
        ...unavailable,
        available: true,
        sent: receipt?.sent === true,
        ...(receipt?.pending
          ? { pending: { rating: receipt.pending.rating, comment: receipt.pending.comment } }
          : {})
      }
    } catch {
      return unavailable
    }
  }

  async submit(raw: unknown): Promise<NotesFeedbackResult> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { status: 'failed', code: 'invalid-request' }
    const request = raw as NotesFeedbackRequest
    if (
      Object.keys(raw).sort().join(',') !== 'comment,generationId,meetingId,rating' ||
      !validMeeting(request.meetingId) ||
      typeof request.generationId !== 'string' ||
      request.generationId.length > 100 ||
      !isNotesFeedbackRating(request.rating) ||
      typeof request.comment !== 'string' ||
      request.comment.length > NOTES_FEEDBACK_COMMENT_LIMIT
    ) {
      return { status: 'failed', code: 'invalid-request' }
    }
    const key = receiptKey(request.meetingId, request.generationId)
    const running = this.pending.get(key)
    if (running) return running
    const operation = this.send(request, key).finally(() => this.pending.delete(key))
    this.pending.set(key, operation)
    return operation
  }

  private async send(request: NotesFeedbackRequest, key: string): Promise<NotesFeedbackResult> {
    const { projectKey, host } = this.options
    if (!projectKey) return { status: 'failed', code: 'unavailable' }
    try {
      const url = new URL('/i/v0/e/', host)
      if (url.protocol !== 'https:' || url.username || url.password)
        return { status: 'failed', code: 'unavailable' }
      const notes = await this.options.readNotes(request.meetingId)
      if (!notes || feedbackGenerationId(notes) !== request.generationId)
        return { status: 'failed', code: 'notes-changed' }
      let receipt = this.options.receipts.get(key)
      if (receipt?.sent)
        return { status: 'already-sent', analyticsEnabled: this.options.analyticsEnabled() }
      if (!receipt) {
        receipt = { submissionId: randomUUID(), sent: false, timestamp: new Date().toISOString() }
        // Persist before sending: a lost response or app restart must reuse the same ID.
        this.options.receipts.set(key, receipt)
      }
      const body = receipt.pending ?? {
        submission_id: receipt.submissionId,
        rating: request.rating,
        comment: request.comment.trim(),
        app_version: this.options.appVersion,
        platform: this.options.platform,
        notes_engine_version: notes.generation?.engineVersion ?? 'unknown'
      }
      if (!isNotesFeedbackEnvelope(body)) return { status: 'failed', code: 'invalid-request' }
      receipt = { ...receipt, pending: body }
      this.options.receipts.set(key, receipt)
      const response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: projectKey,
          ...buildNotesFeedbackEvent(body, receipt.timestamp)
        }),
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) return { status: 'failed', code: 'send-failed' }
      const result = (await response.json()) as { status?: number | string }
      if (result.status !== 1 && result.status !== 'Ok')
        return { status: 'failed', code: 'send-failed' }
      this.options.receipts.set(key, {
        submissionId: receipt.submissionId,
        timestamp: receipt.timestamp,
        sent: true
      })
      return { status: 'sent', analyticsEnabled: this.options.analyticsEnabled() }
    } catch {
      // Never log a comment, response body, notes, or identifiers.
      return { status: 'failed', code: 'send-failed' }
    }
  }
}
