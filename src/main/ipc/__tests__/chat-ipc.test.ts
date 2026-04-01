import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

import {
  extractQuestionTerms,
  scoreMeetingRelevance,
  sortMeetingsByQuestion,
} from '../chat-ipc'

describe('chat meeting retrieval helpers', () => {
  it('drops generic filler terms from broad meeting questions', () => {
    expect(extractQuestionTerms('What happened in my stand up meetings this week?')).toEqual([
      'stand',
    ])
  })

  it('prefers stand-up titles over newer unrelated meetings', () => {
    const ranked = sortMeetingsByQuestion(
      [
        { title: 'Slack - Huddle Preview — Apr 1 at 12:40 PM', date: 200 },
        { title: 'Duet Display Stand Up — Apr 1 at 10:39 AM', date: 100 },
      ],
      'What happened in my stand up meetings this week?',
    )

    expect(ranked[0]?.title).toContain('Stand Up')
  })

  it('falls back to note content when the title is generic', () => {
    expect(
      scoreMeetingRelevance(
        'Entire screen — Apr 1 at 10:39 AM',
        'What happened with the iOS rollout?',
        'Pause iOS rollout due to version 3.1.3 issues.',
      ),
    ).toBeGreaterThan(
      scoreMeetingRelevance(
        'Entire screen — Apr 1 at 10:39 AM',
        'What happened with the iOS rollout?',
        'Test meeting notes generation and transcription accuracy.',
      ),
    )
  })
})
