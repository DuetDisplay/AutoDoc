import type { IaItem } from './types.ts'

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'then',
  'there',
  'this',
  'to',
  'was',
  'we',
  'were',
  'with',
  'you'
])

export function itemText(item: Pick<IaItem, 'title' | 'content'>): string {
  const title = item.title?.trim() ?? ''
  const content = item.content.trim()
  if (title && content && title !== content) return `${title} ${content}`
  return title || content
}

export function contentWords(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return new Set(tokens.filter((token) => token.length > 2 && !STOPWORDS.has(token)))
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0
  let intersection = 0
  for (const word of left) {
    if (right.has(word)) intersection += 1
  }
  const union = left.size + right.size - intersection
  return union === 0 ? 0 : intersection / union
}

export function countWords(markdown: string): number {
  const tokens = markdown.trim().match(/\S+/g)
  return tokens?.length ?? 0
}
