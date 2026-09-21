import { formatSourceSuffix } from './timestamps.ts'
import type { IaDocument, IaItem } from './types.ts'

function formatCore(item: IaItem): string {
  const title = item.title?.trim() ?? ''
  const content = item.content.trim()
  let core: string
  if (title && content && title !== content) core = `**${title}** — ${content}`
  else core = content || title
  if (item.owner) core += ` (Owner: ${item.owner})`
  if (item.deadline) core += ` (Due: ${item.deadline})`
  const suffix = formatSourceSuffix(item.sources)
  return suffix ? `${core} ${suffix}` : core
}

function renderItem(item: IaItem, depth: number): string[] {
  const indent = '  '.repeat(depth)
  const [first, ...rest] = formatCore(item).split('\n')
  const lines = [`${indent}- ${first}`]
  for (const line of rest) {
    lines.push(`${indent}  ${line}`)
  }
  for (const child of item.children) {
    lines.push(...renderItem(child, depth + 1))
  }
  return lines
}

export function renderDocument(document: IaDocument): string {
  const lines: string[] = [`# ${document.title}`, '']
  for (const section of document.sections) {
    if (section.items.length === 0) continue
    lines.push(`## ${section.title}`, '')
    for (const item of section.items) {
      lines.push(...renderItem(item, 0))
    }
    lines.push('')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return `${lines.join('\n')}\n`
}
