import { dedupClusters } from './dedup.ts'
import { demoteModality } from './demote.ts'
import { buildBucketHeadings, buildMeetingHeadings } from './headings.ts'
import { assertRangePreservation, buildMetrics, collectRanges } from './metrics.ts'
import { nestDetails } from './nest.ts'
import { parseMeetingSegments, parsePresentation, presentationToDocument, segmentsToItems } from './parse.ts'
import { renderDocument } from './render.ts'
import type { IaItem, PipelineResult, SourceRange, TransformFlags } from './types.ts'

const ALL_OFF: TransformFlags = {
  dedupClusters: false,
  demoteModality: false,
  nestDetails: false,
  meetingHeadings: false
}

function flattenInputRanges(items: readonly IaItem[]): SourceRange[] {
  const ranges: SourceRange[] = []
  const visit = (item: IaItem): void => {
    ranges.push(...item.sources)
    item.children.forEach(visit)
  }
  items.forEach(visit)
  return ranges
}

export function transformItems(items: readonly IaItem[], flags: TransformFlags): Omit<PipelineResult, 'metrics'> & {
  itemsDemoted: number
  exactDuplicatesDropped: number
  timestampClusterChildren: number
  nestChildrenAdded: number
  emptyHeadingsSuppressed: number
  inputRanges: SourceRange[]
} {
  const inputRanges = flattenInputRanges(items)
  let next = items.map((item) => ({
    ...item,
    sources: item.sources.map((range) => ({ ...range })),
    children: item.children.map((child) => ({ ...child }))
  }))

  let exactDuplicatesDropped = 0
  let timestampClusterChildren = 0
  let itemsDemoted = 0
  let nestChildrenAdded = 0

  if (flags.dedupClusters) {
    const deduped = dedupClusters(next)
    next = deduped.items
    exactDuplicatesDropped = deduped.stats.exactDuplicatesDropped
    timestampClusterChildren = deduped.stats.timestampClusterChildren
  }
  if (flags.demoteModality) {
    const demoted = demoteModality(next)
    next = demoted.items
    itemsDemoted = demoted.demoted
  }
  if (flags.nestDetails) {
    const nested = nestDetails(next)
    next = nested.items
    nestChildrenAdded = nested.nestChildrenAdded
  }

  const built = flags.meetingHeadings ? buildMeetingHeadings(next) : buildBucketHeadings(next)
  const markdown = renderDocument(built.document)
  assertRangePreservation(inputRanges, collectRanges(built.document))

  return {
    document: built.document,
    markdown,
    flags,
    itemsDemoted,
    exactDuplicatesDropped,
    timestampClusterChildren,
    nestChildrenAdded,
    emptyHeadingsSuppressed: built.emptyHeadingsSuppressed,
    inputRanges
  }
}

export function transformSegments(value: unknown, flags: TransformFlags = ALL_OFF): PipelineResult {
  const items = segmentsToItems(parseMeetingSegments(value))
  const transformed = transformItems(items, flags)
  const metrics = buildMetrics({
    markdown: transformed.markdown,
    document: transformed.document,
    inputRanges: transformed.inputRanges,
    itemsDemoted: transformed.itemsDemoted,
    exactDuplicatesDropped: transformed.exactDuplicatesDropped,
    timestampClusterChildren: transformed.timestampClusterChildren,
    nestChildrenAdded: transformed.nestChildrenAdded,
    emptyHeadingsSuppressed: transformed.emptyHeadingsSuppressed
  })
  return {
    document: transformed.document,
    markdown: transformed.markdown,
    metrics,
    flags: transformed.flags
  }
}

export function transformPresentation(value: unknown): PipelineResult {
  const parsed = parsePresentation(value)
  const converted = presentationToDocument(parsed)
  const flags = ALL_OFF
  const document = { title: converted.title, sections: converted.sections }
  const markdown = renderDocument(document)
  const inputRanges = parsed.evidence.blocks.flatMap((block) => block.sources)
  assertRangePreservation(inputRanges, collectRanges(document))
  const metrics = buildMetrics({
    markdown,
    document,
    inputRanges,
    itemsDemoted: 0,
    exactDuplicatesDropped: 0,
    timestampClusterChildren: 0,
    nestChildrenAdded: 0,
    emptyHeadingsSuppressed: 0
  })
  return { document, markdown, metrics, flags }
}
