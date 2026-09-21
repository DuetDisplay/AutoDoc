import { describe, expect, it, vi } from 'vitest'
import { NotesFeedbackService, type FeedbackReceipt } from '../notes-feedback'
import type { MeetingNotesV2 } from '../../../shared/types'
import { NOTES_FEEDBACK_DETAIL_QUESTION_ID } from '../../../shared/notes-feedback'

function fixture(consent = false) {
  const receipts = new Map<string, FeedbackReceipt>()
  const notes = {
    meetingId: 'meeting-private',
    generation: { id: '85c540e8-706f-4fb3-8112-98764a433caf', engineVersion: 'v2.1' }
  } as MeetingNotesV2
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'Ok' })))
  const options = {
    receipts,
    readNotes: vi.fn(async () => notes),
    projectKey: 'test-project',
    host: 'https://us.i.posthog.com',
    appVersion: '1.1.1',
    platform: 'darwin' as const,
    analyticsEnabled: () => consent,
    fetch
  }
  const request = {
    meetingId: notes.meetingId,
    generationId: notes.generation!.id,
    rating: 'useful' as const,
    comment: 'Clear next steps'
  }
  return { service: new NotesFeedbackService(options), options, request, fetch, receipts, notes }
}

describe('explicit notes feedback', () => {
  it.each([false, true])(
    'sends only disclosed fields with analytics consent %s',
    async (consent) => {
      const f = fixture(consent)
      expect(await f.service.state(f.request.meetingId, f.request.generationId)).toMatchObject({
        available: true,
        sent: false
      })
      expect(f.fetch).not.toHaveBeenCalled()
      expect(await f.service.submit(f.request)).toEqual({
        status: 'sent',
        analyticsEnabled: consent
      })
      const body = JSON.parse(f.fetch.mock.calls[0][1].body)
      expect(body.event).toBe('survey sent')
      expect(body.distinct_id).toBe(`notes-feedback:${body.uuid}`)
      expect(body.properties).toEqual({
        $survey_id: expect.any(String),
        $survey_submission_id: body.uuid,
        '$survey_response_d5a8b6aa-995c-44d0-aff7-0146b95325c7': 'Useful',
        [`$survey_response_${NOTES_FEEDBACK_DETAIL_QUESTION_ID}`]: 'Clear next steps',
        $survey_completed: true,
        feedback_kind: 'notes_v2',
        rating: 'useful',
        has_comment: true,
        app_version: '1.1.1',
        platform: 'darwin',
        notes_engine_version: 'v2.1',
        is_test: false,
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: '0.0.0.0'
      })
      expect(JSON.stringify(body)).not.toContain('meeting-private')
      expect(JSON.stringify(body)).not.toContain(f.request.generationId)
      expect([...f.receipts.values()][0].pending).toBeUndefined()
    }
  )

  it('reuses the identical response, timestamp and UUID after a lost response and restart', async () => {
    const f = fixture()
    f.fetch.mockRejectedValueOnce(new Error('offline'))
    expect(await f.service.submit(f.request)).toMatchObject({ status: 'failed' })
    const restarted = new NotesFeedbackService(f.options)
    expect(await restarted.state(f.request.meetingId, f.request.generationId)).toMatchObject({
      sent: false,
      pending: { comment: f.request.comment }
    })
    await restarted.submit({ ...f.request, comment: 'Changed while retrying' })
    expect(f.fetch.mock.calls[0][1].body).toBe(f.fetch.mock.calls[1][1].body)
    const revisited = new NotesFeedbackService(f.options)
    expect(await revisited.submit(f.request)).toMatchObject({ status: 'already-sent' })
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not mark HTTP or invalid acknowledgements as sent', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    expect(await f.service.submit(f.request)).toMatchObject({ status: 'failed' })
    f.fetch.mockResolvedValueOnce(new Response('{"status":0}'))
    expect(await f.service.submit(f.request)).toMatchObject({ status: 'failed' })
    expect([...f.receipts.values()][0].sent).toBe(false)
  })

  it('deduplicates simultaneous sends and permits a new generated version', async () => {
    const f = fixture()
    await Promise.all([f.service.submit(f.request), f.service.submit(f.request)])
    expect(f.fetch).toHaveBeenCalledTimes(1)
    f.notes.generation!.id = '21e184b6-7f7e-4d43-85bd-10891a122dd7'
    expect(await f.service.submit(f.request)).toMatchObject({
      status: 'failed',
      code: 'notes-changed'
    })
    f.fetch.mockResolvedValue(new Response('{"status":1}'))
    await f.service.submit({ ...f.request, generationId: f.notes.generation!.id })
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(f.fetch.mock.calls[0][1].body).uuid).not.toBe(
      JSON.parse(f.fetch.mock.calls[1][1].body).uuid
    )
  })

  it('rejects oversized, extra-field, and path traversal requests without sending', async () => {
    const f = fixture()
    for (const request of [
      { ...f.request, meetingId: '../private' },
      { ...f.request, comment: 'x'.repeat(2001) },
      { ...f.request, transcript: 'private' }
    ]) {
      expect(await f.service.submit(request)).toMatchObject({
        status: 'failed',
        code: 'invalid-request'
      })
    }
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
