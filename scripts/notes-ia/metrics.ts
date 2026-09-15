import { countWords } from './text.ts'
import { rangeKey } from './timestamps.ts'
import type { IaDocument, IaItem, IaMetrics, SourceRange } from './types.ts'

export function walkItems(items: readonly IaItem[], visit: (item: IaItem, depth: number) => void, depth = 0): void {
  for (const item of items) {
    visit(item, depth)
    walkItems(item.children, visit, depth + 1)
  }
}

export function collectRanges(document: IaDocument): SourceRange[] {
  const ranges: SourceRange[] = []
  for (const section of document.sections) {
    walkItems(section.items, (item) => {
      ranges.push(...item.sources)
    })
  }
  return ranges
}

export function distinctRangeKeys(ranges: readonly SourceRange[]): Set<string> {
  return new Set(ranges.map(rangeKey))
}

export function assertRangePreservation(
  inputRanges: readonly SourceRange[],
  outputRanges: readonly SourceRange[]
): void {
  const input = distinctRangeKeys(inputRanges)
  const output = distinctRangeKeys(outputRanges)
  for (const key of output) {
    if (!input.has(key)) throw new Error('Output fabricated a source range.')
  }
  for (const key of input) {
    if (!output.has(key)) throw new Error('Output dropped an input source range.')
  }
}

export function buildMetrics(input: {
  markdown: string
  document: IaDocument
  inputRanges: readonly SourceRange[]
  itemsDemoted: number
  exactDuplicatesDropped: number
  timestampClusterChildren: number
  nestChildrenAdded: number
  emptyHeadingsSuppressed: number
}): IaMetrics {
  const nestDepth: Record<string, number> = {}
  let bulletCount = 0
  for (const section of input.document.sections) {
    walkItems(section.items, (_item, depth) => {
      bulletCount += 1
      const key = String(depth)
      nestDepth[key] = (nestDepth[key] ?? 0) + 1
    })
  }
  const outputRanges = collectRanges(input.document)
  return {
    wordCount: countWords(input.markdown),
    bulletCount,
    headingCount: 1 + input.document.sections.length,
    itemsDemoted: input.itemsDemoted,
    itemsDeduped: input.exactDuplicatesDropped + input.timestampClusterChildren,
    exactDuplicatesDropped: input.exactDuplicatesDropped,
    timestampClusterChildren: input.timestampClusterChildren,
    nestChildrenAdded: input.nestChildrenAdded,
    emptyHeadingsSuppressed: input.emptyHeadingsSuppressed,
    nestDepth,
    rangesIn: input.inputRanges.length,
    rangesOut: outputRanges.length,
    distinctRangesIn: distinctRangeKeys(input.inputRanges).size,
    distinctRangesOut: distinctRangeKeys(outputRanges).size
  }
}
