import { describe, expect, it } from 'vitest'
import type { MeetingNotesContent, NoteItem, NoteSection } from '../../../shared/types'
import {
  applyNotesBudget,
  countNotesWords,
  LONG_MEETING_WORD_BUDGET,
  MAX_KEY_POINTS,
  MAX_SECTIONS,
  SHORT_MEETING_WORD_BUDGET
} from '../notes-scan-budget'

function item(id: string, text: string): NoteItem {
  return {
    id,
    title: text,
    topic: null,
    owner: null,
    deadline: null,
    text,
    sources: [],
    provenance: 'generated',
    completed: false
  }
}

function section(id: string, title: string, points: NoteItem[], details: NoteItem[] = []): NoteSection {
  return {
    id,
    title,
    summary: null,
    keyPoints: points,
    supportingDetails: details
  }
}

function notes(sections: NoteSection[], nextSteps: NoteItem[] = []): MeetingNotesContent {
  return {
    overview: null,
    keyTakeaways: [],
    sections,
    decisions: [],
    nextSteps
  }
}

describe('applyNotesBudget', () => {
  it('caps sections and bullets on a short meeting while keeping tickets and quantities', () => {
    const bloated = notes(
      Array.from({ length: 10 }, (_, index) =>
        section(
          `s${index}`,
          `Topic ${index}`,
          Array.from({ length: 8 }, (_, point) =>
            item(`p${index}-${point}`, `Generic filler point ${index} ${point} about process`)
          ),
          [
            item(`d${index}-ticket`, index === 0 ? 'Follow up on DD1450 with logs' : 'Extra color'),
            item(`d${index}-qty`, index === 1 ? 'Board shows 14 starts today' : 'More color'),
            item(`d${index}-extra`, 'Repeated recap of the same discussion')
          ]
        )
      )
    )

    const result = applyNotesBudget(bloated, 33 * 60 * 1000)
    expect(result.sections.length).toBeLessThanOrEqual(MAX_SECTIONS)
    expect(result.sections.every((row) => row.keyPoints.length <= MAX_KEY_POINTS)).toBe(true)
    const text = result.sections
      .flatMap((row) => [...row.keyPoints, ...row.supportingDetails])
      .map((row) => row.text)
      .join('\n')
    expect(text).toContain('DD1450')
    expect(text).toMatch(/14 starts/i)
    expect(countNotesWords(result)).toBeLessThanOrEqual(SHORT_MEETING_WORD_BUDGET)
    expect(countNotesWords(result)).toBeLessThan(countNotesWords(bloated))
  })

  it('allows a longer budget on a long meeting but still drops inventory filler', () => {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod'
    const bloated = notes(
      Array.from({ length: 8 }, (_, index) =>
        section(
          `s${index}`,
          `Workstream ${index}`,
          Array.from({ length: 6 }, (_, point) => item(`p${index}-${point}`, `${filler} ${point}`))
        )
      )
    )
    const result = applyNotesBudget(bloated, 56 * 60 * 1000)
    expect(countNotesWords(result)).toBeLessThanOrEqual(LONG_MEETING_WORD_BUDGET)
    expect(result.sections.length).toBeLessThanOrEqual(MAX_SECTIONS)
  })
})
