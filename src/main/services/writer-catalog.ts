import type { MeetingSegments, Segment } from '../../shared/types'

export interface WriterCatalog {
  items: Segment[]
  nextSteps: Segment[]
}

export function emptyWriterCatalog(): WriterCatalog {
  return { items: [], nextSteps: [] }
}

export function emptyMeetingSegments(): MeetingSegments {
  return {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }
}

export function isWriterCatalog(value: unknown): value is WriterCatalog {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Array.isArray(record.items) && Array.isArray(record.nextSteps)
}

export function isLegacyMeetingSegments(value: unknown): value is MeetingSegments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Array.isArray(record.decisions) &&
    Array.isArray(record.actionItems) &&
    Array.isArray(record.information) &&
    Array.isArray(record.discussion) &&
    Array.isArray(record.statusUpdates)
  )
}

export function writerCatalogFromSegments(segments: MeetingSegments): WriterCatalog {
  return {
    items: [
      ...segments.information,
      ...segments.decisions,
      ...segments.discussion,
      ...segments.statusUpdates
    ],
    nextSteps: [...segments.actionItems]
  }
}

export function meetingSegmentsFromWriterCatalog(catalog: WriterCatalog): MeetingSegments {
  return {
    decisions: [],
    actionItems: catalog.nextSteps,
    information: catalog.items,
    discussion: [],
    statusUpdates: []
  }
}

export function meetingSegmentsFromDisk(value: unknown): MeetingSegments {
  if (isWriterCatalog(value)) {
    return meetingSegmentsFromWriterCatalog(value)
  }
  if (isLegacyMeetingSegments(value)) {
    return value
  }
  return emptyMeetingSegments()
}
