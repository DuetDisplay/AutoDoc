import type { Bucket, IaItem, MeetingSegments, Segment } from '../types.ts'

export function segment(input: {
  id: string
  bucket: Bucket
  title: string
  content: string
  topic?: string | null
  startMs: number
  endMs: number
  owner?: string | null
  deadline?: string | null
}): Segment {
  const category =
    input.bucket === 'actionItems'
      ? 'action_item'
      : input.bucket === 'statusUpdates'
        ? 'status_update'
        : input.bucket === 'decisions'
          ? 'decision'
          : input.bucket === 'discussion'
            ? 'discussion'
            : 'information'
  return {
    id: input.id,
    meetingId: 'synthetic-orion-clock-sync',
    category,
    topic: input.topic ?? 'Clock protocol',
    title: input.title,
    content: input.content,
    assignee: input.owner ?? null,
    deadline: input.deadline ?? null,
    sourceStartMs: input.startMs,
    sourceEndMs: input.endMs
  }
}

export function emptySegments(): MeetingSegments {
  return {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }
}

export function item(input: {
  id: string
  bucket?: Bucket
  title?: string | null
  content: string
  topic?: string | null
  startMs: number
  endMs: number
  owner?: string | null
  deadline?: string | null
  children?: IaItem[]
}): IaItem {
  return {
    id: input.id,
    title: input.title ?? null,
    content: input.content,
    topic: input.topic ?? 'Clock protocol',
    bucket: input.bucket ?? 'information',
    owner: input.owner ?? null,
    deadline: input.deadline ?? null,
    sources: [{ startMs: input.startMs, endMs: input.endMs }],
    children: input.children ?? []
  }
}
