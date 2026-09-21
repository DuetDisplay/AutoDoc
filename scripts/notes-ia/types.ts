export type Bucket =
  | 'decisions'
  | 'actionItems'
  | 'information'
  | 'discussion'
  | 'statusUpdates'

export const BUCKETS: readonly Bucket[] = [
  'decisions',
  'actionItems',
  'information',
  'discussion',
  'statusUpdates'
]

/** P0 five-bucket heading order matches the frozen 1.1.1 control shell. */
export const P0_BUCKET_ORDER: readonly Bucket[] = [
  'information',
  'decisions',
  'actionItems',
  'discussion',
  'statusUpdates'
]

export const BUCKET_HEADINGS: Record<Bucket, string> = {
  information: 'Information',
  decisions: 'Decisions',
  actionItems: 'Action Items',
  discussion: 'Discussion',
  statusUpdates: 'Status Updates'
}

export interface SourceRange {
  startMs: number
  endMs: number
}

export interface Segment {
  id: string
  meetingId: string
  category: string
  topic: string | null
  title: string
  content: string
  assignee: string | null
  deadline: string | null
  sourceStartMs: number
  sourceEndMs: number
}

export interface MeetingSegments {
  decisions: Segment[]
  actionItems: Segment[]
  information: Segment[]
  discussion: Segment[]
  statusUpdates: Segment[]
}

export interface IaItem {
  id: string
  title: string | null
  content: string
  topic: string | null
  bucket: Bucket
  owner: string | null
  deadline: string | null
  sources: SourceRange[]
  children: IaItem[]
}

export type SectionKind = 'topic' | 'bucket' | 'decisions' | 'next-steps'

export interface IaSection {
  title: string
  kind: SectionKind
  items: IaItem[]
}

export interface IaDocument {
  title: string
  sections: IaSection[]
}

export interface TransformFlags {
  dedupClusters: boolean
  demoteModality: boolean
  nestDetails: boolean
  meetingHeadings: boolean
}

export interface IaMetrics {
  wordCount: number
  bulletCount: number
  headingCount: number
  itemsDemoted: number
  itemsDeduped: number
  exactDuplicatesDropped: number
  timestampClusterChildren: number
  nestChildrenAdded: number
  emptyHeadingsSuppressed: number
  nestDepth: Record<string, number>
  rangesIn: number
  rangesOut: number
  distinctRangesIn: number
  distinctRangesOut: number
}

export interface PipelineResult {
  document: IaDocument
  markdown: string
  metrics: IaMetrics
  flags: TransformFlags
}

export interface PresentationBlock {
  location: string
  title: string | null
  sources: SourceRange[]
}

export interface PresentationJson {
  schemaVersion: number
  format: string
  markdown: string
  evidence: {
    available: boolean
    blocks: PresentationBlock[]
  }
}
