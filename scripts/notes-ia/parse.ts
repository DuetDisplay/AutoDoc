import { BUCKETS } from './types.ts'
import type { IaItem, MeetingSegments, PresentationJson, Segment, SourceRange } from './types.ts'

class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParseError'
  }
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ParseError('Expected a plain object.')
  }
  return value as Record<string, unknown>
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ParseError(`Expected string field ${field}.`)
  return value
}

function expectNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return expectString(value, field)
}

function expectFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ParseError(`Expected non-negative finite number ${field}.`)
  }
  return value
}

function parseSegment(value: unknown): Segment {
  const record = expectRecord(value)
  return {
    id: expectString(record.id, 'id'),
    meetingId: expectString(record.meetingId, 'meetingId'),
    category: expectString(record.category, 'category'),
    topic: expectNullableString(record.topic, 'topic'),
    title: expectString(record.title, 'title'),
    content: expectString(record.content, 'content'),
    assignee: expectNullableString(record.assignee, 'assignee'),
    deadline: expectNullableString(record.deadline, 'deadline'),
    sourceStartMs: expectFiniteNumber(record.sourceStartMs, 'sourceStartMs'),
    sourceEndMs: expectFiniteNumber(record.sourceEndMs, 'sourceEndMs')
  }
}

export function parseMeetingSegments(value: unknown): MeetingSegments {
  const record = expectRecord(value)
  const segments = {} as MeetingSegments
  for (const bucket of BUCKETS) {
    const list = record[bucket]
    if (!Array.isArray(list)) throw new ParseError(`Expected array bucket ${bucket}.`)
    segments[bucket] = list.map((item) => parseSegment(item))
  }
  return segments
}

export function segmentsToItems(segments: MeetingSegments): IaItem[] {
  const items: IaItem[] = []
  for (const bucket of BUCKETS) {
    for (const segment of segments[bucket]) {
      items.push({
        id: segment.id,
        title: segment.title,
        content: segment.content,
        topic: segment.topic,
        bucket,
        owner: segment.assignee,
        deadline: segment.deadline,
        sources: [{ startMs: segment.sourceStartMs, endMs: segment.sourceEndMs }],
        children: []
      })
    }
  }
  return items
}

function parseRange(value: unknown): SourceRange {
  const record = expectRecord(value)
  return {
    startMs: expectFiniteNumber(record.startMs, 'startMs'),
    endMs: expectFiniteNumber(record.endMs, 'endMs')
  }
}

export function parsePresentation(value: unknown): PresentationJson {
  const record = expectRecord(value)
  const evidence = expectRecord(record.evidence)
  const blocksValue = evidence.blocks
  if (!Array.isArray(blocksValue)) throw new ParseError('Expected evidence.blocks array.')
  return {
    schemaVersion: expectFiniteNumber(record.schemaVersion, 'schemaVersion'),
    format: expectString(record.format, 'format'),
    markdown: expectString(record.markdown, 'markdown'),
    evidence: {
      available: Boolean(evidence.available),
      blocks: blocksValue.map((block) => {
        const row = expectRecord(block)
        const sourcesValue = row.sources
        if (!Array.isArray(sourcesValue)) throw new ParseError('Expected block.sources array.')
        return {
          location: expectString(row.location, 'location'),
          title: expectNullableString(row.title, 'title'),
          sources: sourcesValue.map(parseRange)
        }
      })
    }
  }
}

export function presentationToDocument(presentation: PresentationJson): {
  title: string
  sections: { title: string; kind: 'topic'; items: IaItem[] }[]
} {
  const lines = presentation.markdown.split(/\r?\n/)
  let documentTitle = 'Meeting notes'
  const sections: { title: string; items: string[] }[] = []
  let current: { title: string; items: string[] } | null = null

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const title = heading[2].trim()
      if (level === 1) {
        documentTitle = title || documentTitle
        continue
      }
      if (level === 2) {
        current = { title, items: [] }
        sections.push(current)
      }
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!current) {
        current = { title: 'Notes', items: [] }
        sections.push(current)
      }
      current.items.push(bullet[1])
      continue
    }
    if (current && current.items.length > 0 && line.trim() !== '') {
      const last = current.items.length - 1
      current.items[last] = `${current.items[last]}\n${line}`
    }
  }

  const bullets = sections.flatMap((section) => section.items)
  if (bullets.length !== presentation.evidence.blocks.length) {
    throw new ParseError('Presentation evidence block count does not match markdown bullets.')
  }

  let index = 0
  return {
    title: documentTitle,
    sections: sections
      .filter((section) => section.items.length > 0)
      .map((section) => ({
        title: section.title,
        kind: 'topic' as const,
        items: section.items.map((text) => {
          const block = presentation.evidence.blocks[index]
          index += 1
          return {
            id: `presentation:${index}`,
            title: block.title,
            content: text,
            topic: section.title,
            bucket: 'information' as const,
            owner: null,
            deadline: null,
            sources: block.sources.map((range) => ({ ...range })),
            children: []
          }
        })
      }))
  }
}
