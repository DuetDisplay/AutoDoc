/** Bump when the notes pipeline/prompts change, independently of the document schema. */
export const NOTES_ENGINE_VERSION = 'v2.1'
export const NOTES_FEEDBACK_SURVEY_ID = '01a0c5be-0a26-0000-e57e-def4047e2196'
export const NOTES_FEEDBACK_RATING_QUESTION_ID = 'd5a8b6aa-995c-44d0-aff7-0146b95325c7'
export const NOTES_FEEDBACK_DETAIL_QUESTION_ID = '6902d2f3-2f6d-48b7-b27f-85292fd28fd5'
export const NOTES_FEEDBACK_COMMENT_LIMIT = 2000
export const NOTES_FEEDBACK_RATINGS = ['useful', 'somewhat_useful', 'not_useful'] as const
export type NotesFeedbackRating = (typeof NOTES_FEEDBACK_RATINGS)[number]

export interface NotesGeneration {
  id: string
  engineVersion: string
}

export interface NotesFeedbackRequest {
  meetingId: string
  generationId: string
  rating: NotesFeedbackRating
  comment: string
}

export interface NotesFeedbackState {
  available: boolean
  sent: boolean
  analyticsEnabled: boolean
  pending?: { rating: NotesFeedbackRating; comment: string }
}

export type NotesFeedbackResult =
  | { status: 'sent' | 'already-sent'; analyticsEnabled: boolean }
  | { status: 'failed'; code: 'unavailable' | 'invalid-request' | 'notes-changed' | 'send-failed' }

/** No meeting ID, content hash, installation identity, or analytics identity leaves the device. */
export interface NotesFeedbackEnvelope {
  submission_id: string
  rating: NotesFeedbackRating
  comment: string
  app_version: string
  platform: 'darwin' | 'win32' | 'linux'
  notes_engine_version: string
}

export function feedbackGenerationId(notes: { generation?: NotesGeneration }): string {
  // Historical documents have no reliable engine provenance; do not guess from app version.
  return notes.generation?.id ?? 'legacy-v2'
}

export function isNotesFeedbackRating(value: unknown): value is NotesFeedbackRating {
  return NOTES_FEEDBACK_RATINGS.some((rating) => rating === value)
}

export function isFeedbackUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  )
}

export function isNotesFeedbackEnvelope(value: unknown): value is NotesFeedbackEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  const keys = [
    'submission_id',
    'rating',
    'comment',
    'app_version',
    'platform',
    'notes_engine_version'
  ]
  return (
    Object.keys(body).length === keys.length &&
    keys.every((key) => key in body) &&
    isFeedbackUuid(body.submission_id) &&
    isNotesFeedbackRating(body.rating) &&
    typeof body.comment === 'string' &&
    body.comment.length <= NOTES_FEEDBACK_COMMENT_LIMIT &&
    typeof body.app_version === 'string' &&
    /^\d+\.\d+\.\d+[a-zA-Z0-9.+-]{0,48}$/.test(body.app_version) &&
    ['darwin', 'win32', 'linux'].includes(body.platform as string) &&
    typeof body.notes_engine_version === 'string' &&
    /^(unknown|v\d+\.\d+)$/.test(body.notes_engine_version)
  )
}

/** Dedicated explicit-feedback capture. Never merge normal analytics context into this event. */
export function buildNotesFeedbackEvent(body: NotesFeedbackEnvelope, timestamp: string) {
  const labels = { useful: 'Useful', somewhat_useful: 'Somewhat useful', not_useful: 'Not useful' }
  return {
    uuid: body.submission_id,
    distinct_id: `notes-feedback:${body.submission_id}`,
    event: 'survey sent',
    timestamp,
    properties: {
      $survey_id: NOTES_FEEDBACK_SURVEY_ID,
      $survey_submission_id: body.submission_id,
      [`$survey_response_${NOTES_FEEDBACK_RATING_QUESTION_ID}`]: labels[body.rating],
      ...(body.comment
        ? { [`$survey_response_${NOTES_FEEDBACK_DETAIL_QUESTION_ID}`]: body.comment }
        : {}),
      $survey_completed: true,
      feedback_kind: 'notes_v2',
      rating: body.rating,
      has_comment: body.comment.length > 0,
      app_version: body.app_version,
      platform: body.platform,
      notes_engine_version: body.notes_engine_version,
      is_test: body.app_version.startsWith('0.0.0-feedback-check-'),
      $process_person_profile: false,
      $geoip_disable: true,
      // A null IP is replaced by the request IP at ingestion. Supply a fixed non-user value.
      $ip: '0.0.0.0'
    }
  }
}
