import type { MeetingNotesContent, NoteItem, NoteSection } from '../../shared/types'
import { ticketsInText, writerQuantitiesInText } from './notes-scan-preserve'

export const SHORT_MEETING_MS = 40 * 60 * 1000
export const SHORT_MEETING_WORD_BUDGET = 720
export const LONG_MEETING_WORD_BUDGET = 1100
export const MAX_SECTIONS = 6
export const MAX_KEY_POINTS = 4
export const MAX_SUPPORTING_DETAILS = 2
export const MAX_NEXT_STEPS = 7
export const MAX_TAKEAWAYS = 3

export interface NotesBudget {
  maxWords: number
  maxSections: number
  maxKeyPoints: number
  maxSupportingDetails: number
  maxNextSteps: number
  maxTakeaways: number
}

export function notesBudgetForDuration(durationMs: number): NotesBudget {
  return {
    maxWords: durationMs > 0 && durationMs < SHORT_MEETING_MS
      ? SHORT_MEETING_WORD_BUDGET
      : LONG_MEETING_WORD_BUDGET,
    maxSections: MAX_SECTIONS,
    maxKeyPoints: MAX_KEY_POINTS,
    maxSupportingDetails: MAX_SUPPORTING_DETAILS,
    maxNextSteps: MAX_NEXT_STEPS,
    maxTakeaways: MAX_TAKEAWAYS
  }
}

export function countNotesWords(content: MeetingNotesContent): number {
  return notesText(content)
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0).length
}

export function isProtectedNoteText(text: string): boolean {
  return ticketsInText(text).length > 0 || writerQuantitiesInText(text).length > 0
}

function itemText(item: NoteItem): string {
  return `${item.title ?? ''} ${item.text}`
}

function notesText(content: MeetingNotesContent): string {
  const parts: string[] = []
  if (content.overview?.text) parts.push(content.overview.text)
  for (const item of content.keyTakeaways) parts.push(itemText(item))
  for (const section of content.sections) {
    parts.push(section.title)
    for (const item of [...section.keyPoints, ...section.supportingDetails]) {
      parts.push(itemText(item))
    }
  }
  for (const item of content.nextSteps) parts.push(itemText(item))
  return parts.join('\n')
}

function takeProtectedFirst(items: readonly NoteItem[], limit: number): NoteItem[] {
  if (items.length <= limit) return [...items]
  const protectedItems = items.filter((item) => isProtectedNoteText(itemText(item)))
  const rest = items.filter((item) => !isProtectedNoteText(itemText(item)))
  const room = Math.max(limit - protectedItems.length, 0)
  return [...protectedItems, ...rest.slice(0, room)]
}

function trimSection(section: NoteSection, budget: NotesBudget): NoteSection {
  return {
    ...section,
    keyPoints: takeProtectedFirst(section.keyPoints, budget.maxKeyPoints),
    supportingDetails: takeProtectedFirst(section.supportingDetails, budget.maxSupportingDetails)
  }
}

function trimSections(sections: readonly NoteSection[], budget: NotesBudget): NoteSection[] {
  const trimmed = sections
    .map((section) => trimSection(section, budget))
    .filter(
      (section) => section.keyPoints.length > 0 || section.supportingDetails.length > 0
    )
  if (trimmed.length <= budget.maxSections) return trimmed

  const protectedSections = trimmed.filter((section) =>
    [...section.keyPoints, ...section.supportingDetails].some((item) =>
      isProtectedNoteText(itemText(item))
    )
  )
  const rest = trimmed.filter((section) => !protectedSections.includes(section))
  const room = Math.max(budget.maxSections - protectedSections.length, 0)
  const kept = [...protectedSections, ...rest.slice(0, room)]
  const leftoverProtected = rest.slice(room).flatMap((section) =>
    [...section.keyPoints, ...section.supportingDetails].filter((item) =>
      isProtectedNoteText(itemText(item))
    )
  )
  if (leftoverProtected.length === 0 || kept.length === 0) return kept.slice(0, budget.maxSections)
  const target = kept[kept.length - 1]
  if (!target) return kept
  return [
    ...kept.slice(0, -1),
    {
      ...target,
      supportingDetails: [...target.supportingDetails, ...leftoverProtected]
    }
  ]
}

function dropUnprotectedUntil(content: MeetingNotesContent, maxWords: number): MeetingNotesContent {
  let working = content
  while (countNotesWords(working) > maxWords) {
    let removed = false
    working = {
      ...working,
      sections: working.sections.map((section) => {
        if (removed) return section
        const index = [...section.supportingDetails]
          .reverse()
          .findIndex((item) => !isProtectedNoteText(itemText(item)))
        if (index < 0) return section
        const fromEnd = section.supportingDetails.length - 1 - index
        removed = true
        return {
          ...section,
          supportingDetails: section.supportingDetails.filter((_, itemIndex) => itemIndex !== fromEnd)
        }
      })
    }
    if (removed) continue

    working = {
      ...working,
      sections: working.sections.map((section) => {
        if (removed) return section
        const index = [...section.keyPoints]
          .reverse()
          .findIndex((item) => !isProtectedNoteText(itemText(item)))
        if (index < 0) return section
        const fromEnd = section.keyPoints.length - 1 - index
        removed = true
        return {
          ...section,
          keyPoints: section.keyPoints.filter((_, itemIndex) => itemIndex !== fromEnd)
        }
      })
    }
    if (!removed) break
  }
  return {
    ...working,
    sections: working.sections.filter(
      (section) => section.keyPoints.length > 0 || section.supportingDetails.length > 0
    )
  }
}

export function applyNotesBudget(
  content: MeetingNotesContent,
  durationMs: number
): MeetingNotesContent {
  const budget = notesBudgetForDuration(durationMs)
  const nextSteps = takeProtectedFirst(content.nextSteps, budget.maxNextSteps)
  const keyTakeaways = content.keyTakeaways.slice(0, budget.maxTakeaways)
  const trimmed: MeetingNotesContent = {
    ...content,
    keyTakeaways,
    sections: trimSections(content.sections, budget),
    nextSteps
  }
  return dropUnprotectedUntil(trimmed, budget.maxWords)
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0).length
}
