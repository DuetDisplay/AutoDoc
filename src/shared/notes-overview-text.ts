export function fallbackMeetingOverview(
  sectionTitles: readonly string[],
  meetingTitle?: string
): string {
  const topics = sectionTitles.map((title) => title.trim()).filter((title) => title.length > 0)
  if (topics.length >= 2) {
    const last = topics[topics.length - 1]
    return `This meeting covered ${topics.slice(0, -1).join(', ')}, and ${last}.`
  }
  if (topics.length === 1) return `This meeting focused on ${topics[0]}.`
  const named = meetingTitle?.trim()
  return named ? `Notes from ${named}.` : ''
}

export interface FallbackOverviewSection {
  title: string
  keyPoints?: readonly { text?: string }[]
  supportingDetails?: readonly { text?: string }[]
}

function asSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return ''
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function overviewBulletCandidates(sections: readonly FallbackOverviewSection[]): string[] {
  const titles = new Set(
    sections.map((section) => section.title.trim().toLowerCase()).filter((title) => title.length > 0)
  )
  const seen = new Set<string>()
  const lines: string[] = []
  for (const section of sections) {
    const items = [...(section.keyPoints ?? []), ...(section.supportingDetails ?? [])]
    for (const item of items) {
      const text = (item.text ?? '').replace(/\s+/g, ' ').trim()
      const normalized = text.replace(/[.!?]+$/, '').toLowerCase()
      if (text.length < 24 || titles.has(normalized) || seen.has(normalized)) continue
      seen.add(normalized)
      lines.push(text)
    }
  }
  return lines
}

/** Prefer grounded bullets over a heading list when the overview model pass fails. */
export function fallbackMeetingOverviewFromNotes(
  sections: readonly FallbackOverviewSection[],
  meetingTitle?: string
): string {
  const bullets = overviewBulletCandidates(sections).slice(0, 2).map(asSentence)
  if (bullets.length > 0) return bullets.join(' ')
  return fallbackMeetingOverview(
    sections.map((section) => section.title),
    meetingTitle
  )
}
