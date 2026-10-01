import { describe, expect, it, vi } from 'vitest'
import {
  parseTakeawayPicks,
  selectKeyTakeaways,
  takeawaySelectionPrompt,
  type TakeawaySelectionCompleteFn
} from '../notes-takeaway-selection'

const notes = [
  {
    id: 'a',
    title: 'Wednesday rollout',
    content: 'Proceed with Wednesday rollout if the model is ready.'
  },
  {
    id: 'b',
    title: 'From Fort Lauderdale, slightly more',
    content: 'From Fort Lauderdale, slightly more'
  },
  { id: 'c', title: 'Brevo batches', content: 'Brevo allows up to 10 batches per campaign.' },
  { id: 'd', title: '', content: 'Gabor will add the email to his workflow.' }
]

describe('takeawaySelectionPrompt', () => {
  it('numbers every note once, in order, with title and text', () => {
    const prompt = takeawaySelectionPrompt(notes, 2)!
    expect(prompt).toContain('Choose the 2 notes that are the key takeaways')
    expect(prompt).toContain(
      '1. Wednesday rollout: Proceed with Wednesday rollout if the model is ready.\n' +
        '2. From Fort Lauderdale, slightly more\n' +
        '3. Brevo batches: Brevo allows up to 10 batches per campaign.\n' +
        '4. Gabor will add the email to his workflow.'
    )
    expect(prompt).not.toContain('Write the entire response')
  })

  it('declines notes that would not fit the scan context', () => {
    const long = Array.from({ length: 200 }, (_, index) => ({
      title: `Note ${index}`,
      content: 'A long note about the meeting that repeats itself several times over. '.repeat(2)
    }))
    expect(takeawaySelectionPrompt(long, 3)).toBeNull()
    const cjk = Array.from({ length: 60 }, () => ({
      title: '',
      content: '会議の決定事項について説明する。'.repeat(4)
    }))
    expect(takeawaySelectionPrompt(cjk, 3)).toBeNull()
  })
})

describe('parseTakeawayPicks', () => {
  it('accepts exactly k distinct in-range note numbers', () => {
    expect(parseTakeawayPicks('{"picks":[3,1]}', 4, 2)).toEqual([2, 0])
    expect(parseTakeawayPicks('{"picks":[3]}', 4, 2)).toBeNull()
    expect(parseTakeawayPicks('{"picks":[3,3]}', 4, 2)).toBeNull()
    expect(parseTakeawayPicks('{"picks":[0,5]}', 4, 2)).toBeNull()
    expect(parseTakeawayPicks('{"picks":[1.5,2]}', 4, 2)).toBeNull()
    expect(parseTakeawayPicks('not json', 4, 2)).toBeNull()
  })
})

describe('selectKeyTakeaways', () => {
  it('returns the chosen note ids with an enum-constrained request', async () => {
    const complete = vi.fn<TakeawaySelectionCompleteFn>(async () => '{"picks":[3,1]}')
    await expect(selectKeyTakeaways(notes, 2, complete)).resolves.toEqual({
      status: 'selected',
      ids: ['c', 'a']
    })
    const options = complete.mock.calls[0]![1]
    expect(options).toMatchObject({
      num_ctx: 4096,
      temperature: 0,
      format: {
        properties: { picks: { minItems: 2, maxItems: 2, items: { enum: [1, 2, 3, 4] } } }
      }
    })
  })

  it('keeps the ranking when there is nothing to choose, the answer is invalid, or the call fails', async () => {
    const never = vi.fn<TakeawaySelectionCompleteFn>()
    await expect(selectKeyTakeaways(notes.slice(0, 2), 2, never)).resolves.toEqual({
      status: 'skipped',
      reason: 'too-few-notes'
    })
    await expect(selectKeyTakeaways(notes, 0, never)).resolves.toMatchObject({ status: 'skipped' })
    expect(never).not.toHaveBeenCalled()

    await expect(selectKeyTakeaways(notes, 2, async () => '{"picks":[2,2]}')).resolves.toEqual({
      status: 'failed',
      reason: 'invalid-answer'
    })
    await expect(
      selectKeyTakeaways(notes, 2, async () => {
        throw new Error('ollama down')
      })
    ).resolves.toEqual({ status: 'failed', reason: 'error' })
  })
})
