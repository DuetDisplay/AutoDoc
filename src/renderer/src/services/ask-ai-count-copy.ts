import type { ChatCountSummary } from '../../../shared/types'
import type { MessageKey } from '../../../shared/i18n'
import type { UiLanguageCode } from '../../../shared/ui-language'

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

function legacyFilter(description: string): Pick<ChatCountSummary, 'filter' | 'scoped'> | null {
  const scope = /^(all|attached) saved recordings/u.exec(description)
  if (!scope) return null
  const filter: NonNullable<ChatCountSummary['filter']> = {}
  let remaining = description.slice(scope[0].length).replace(/\s*\(no filters\)\s*$/u, '')
  for (const [key, pattern] of [
    ['from', /on or after (\d{4}-\d{2}-\d{2})/u],
    ['through', /on or before (\d{4}-\d{2}-\d{2})/u]
  ] as const) {
    const match = pattern.exec(remaining)
    if (match) {
      filter[key] = match[1]
      remaining = remaining.replace(match[0], '')
    }
  }
  for (const [key, pattern] of [
    ['title', /with all title terms ("(?:[^"\\]|\\.)*")/u],
    ['participant', /with participant terms ("(?:[^"\\]|\\.)*")/u],
    ['keyword', /whose notes or transcript contain all keyword terms ("(?:[^"\\]|\\.)*")/u]
  ] as const) {
    const match = pattern.exec(remaining)
    if (match) {
      try {
        filter[key] = JSON.parse(match[1]) as string
      } catch {
        return null
      }
      remaining = remaining.replace(match[0], '')
    }
  }
  return remaining.replace(/[\s,]/gu, '') ? null : { filter, scoped: scope[1] === 'attached' }
}

/** Localize the receipt only. The native tool result/history remain byte-identical. */
export function askAiCountFilterCopy(
  summary: ChatCountSummary,
  t: Translate,
  language: UiLanguageCode
): string {
  if (language === 'en') return summary.filterDescription
  const detail = summary.filter ? summary : legacyFilter(summary.filterDescription)
  if (!detail?.filter) return t('askAi.filterUnavailable')
  const scope = t(detail.scoped ? 'askAi.countAttached' : 'askAi.countAll')
  const clauses = (['from', 'through', 'title', 'participant', 'keyword'] as const).flatMap(
    (key) => {
      const value = detail.filter?.[key]
      if (!value) return []
      const keys = {
        from: 'askAi.filterFrom',
        through: 'askAi.filterThrough',
        title: 'askAi.filterTitle',
        participant: 'askAi.filterParticipant',
        keyword: 'askAi.filterKeyword'
      } as const
      return [t(keys[key], { value })]
    }
  )
  return clauses.length
    ? `${scope} · ${clauses.join(' · ')}`
    : `${scope} (${t('askAi.countNoFilters')})`
}
