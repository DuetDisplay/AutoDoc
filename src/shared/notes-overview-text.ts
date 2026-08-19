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
