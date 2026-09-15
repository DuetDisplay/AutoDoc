import { itemText } from '../notes-ia/text.ts'
import type { IaItem } from '../notes-ia/types.ts'

import { firstLine } from './groups.ts'
import { stripLegacyDecorations } from './sanitize.ts'
import {
  contentTokens,
  type ExtractedCommitment,
  renderVerifiedMarkdown
} from './verify-commitments.ts'

const PLACEHOLDER_OWNER = /^(owner|me|them|us|we)$/i
const DEDUP_JACCARD = 0.5

function realOwner(owner: string | null | undefined): string | null {
  if (!owner) return null
  const trimmed = owner.trim()
  if (trimmed.length === 0 || PLACEHOLDER_OWNER.test(trimmed)) return null
  return trimmed
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  const rightSet = new Set(right)
  let intersection = 0
  for (const token of left) {
    if (rightSet.has(token)) intersection += 1
  }
  const union = new Set([...left, ...right]).size
  return union === 0 ? 0 : intersection / union
}

export function commitmentFromLegacy(item: IaItem): ExtractedCommitment {
  const title = stripLegacyDecorations(item.title?.trim() || firstLine(item.content))
  const content = stripLegacyDecorations(item.content)
  const action = title.length > 0 ? title.replace(/\.*$/u, '') : content
  let rationale: string | null = null
  if (content.length > 0 && content !== title && !content.startsWith(title)) {
    rationale = content
  } else if (content.length > title.length + 8) {
    rationale = content
  }
  return {
    index: 0,
    raw: itemText(item),
    action,
    owner: realOwner(item.owner),
    rationale
  }
}

export function unionNextSteps(
  legacy: readonly IaItem[],
  extracted: readonly ExtractedCommitment[]
): ExtractedCommitment[] {
  const merged: ExtractedCommitment[] = [
    ...legacy.map(commitmentFromLegacy),
    ...extracted.map((item) => ({
      ...item,
      owner: realOwner(item.owner),
      action: stripLegacyDecorations(item.action),
      rationale: item.rationale ? stripLegacyDecorations(item.rationale) : null
    }))
  ].filter((item) => item.action.trim().length > 0)

  const kept: ExtractedCommitment[] = []
  for (const item of merged) {
    const tokens = contentTokens(item.action)
    const duplicateAt = kept.findIndex(
      (existing) => jaccard(contentTokens(existing.action), tokens) >= DEDUP_JACCARD
    )
    if (duplicateAt < 0) {
      kept.push(item)
      continue
    }
    const existing = kept[duplicateAt]
    if (!existing) {
      kept.push(item)
      continue
    }
    const preferNew =
      (item.owner && !existing.owner) ||
      (item.action.length > existing.action.length && Boolean(item.owner) === Boolean(existing.owner))
    if (preferNew) kept[duplicateAt] = item
  }
  return kept.map((item, index) => ({ ...item, index: index + 1 }))
}

export function renderDecisionBullets(items: readonly IaItem[]): string {
  const lines: string[] = []
  for (const item of items) {
    const title = stripLegacyDecorations(item.title?.trim() || '')
    const content = stripLegacyDecorations(item.content)
    let core: string
    if (title && content && title !== content) core = `**${title}** — ${content}`
    else core = content || title
    const owner = realOwner(item.owner)
    if (owner) core += ` (${owner})`
    if (core.trim().length === 0) continue
    lines.push(`* ${core}`)
  }
  return lines.join('\n')
}

export function renderUnrestyledItems(items: readonly IaItem[]): string {
  const lines: string[] = []
  const walk = (item: IaItem, depth: number): void => {
    const indent = '  '.repeat(depth)
    const title = stripLegacyDecorations(item.title?.trim() || '')
    const content = stripLegacyDecorations(item.content)
    let core: string
    if (title && content && title !== content) core = `**${title}** — ${content}`
    else core = content || title
    if (core.trim().length > 0) lines.push(`${indent}* ${core}`)
    for (const child of item.children) walk(child, depth + 1)
  }
  for (const item of items) walk(item, 0)
  return lines.join('\n')
}

export function composeDocument(args: {
  title: string
  sections: { name: string; markdown: string }[]
  decisions: readonly IaItem[]
  nextSteps: readonly ExtractedCommitment[]
}): string {
  const blocks: string[] = [`# ${args.title}`, '']
  for (const section of args.sections) {
    const body = section.markdown.trim()
    if (body.length === 0) continue
    blocks.push(`## ${section.name}`, body, '')
  }
  const decisions = renderDecisionBullets(args.decisions)
  if (decisions.length > 0) {
    blocks.push('## Decisions', decisions, '')
  }
  const next = renderVerifiedMarkdown(args.nextSteps).trim()
  if (next.length > 0) {
    blocks.push('## Next Steps', next, '')
  }
  return `${blocks.join('\n').trim()}\n`
}
