export const OTHER_NOTES_TOPIC = 'Other Notes'
export const NEEDS_REVIEW_TOPIC = 'Needs Review'

export const GENERIC_SECTION_TITLES = new Set(['Information', 'Discussion', 'Status Updates'])

/** Writer leftover titles that must never become chapter names. */
export const LEFTOVER_PRESENTATION_TITLE =
  /^(?:but|and|then|so|um+|uh+)\b|^(?:share|look(?:\s+into)?|discuss|send|take(?:\s+a\s+look)?|include|make\s+sure)\b|^(?:identified|identifying|indicating|using|running|updated|created|posted|showing|considering)\b/iu

export function isLeftoverPresentationTitle(title: string | null | undefined): boolean {
  return LEFTOVER_PRESENTATION_TITLE.test(title?.trim() ?? '')
}

export function isNeedsReviewTopic(topic: string | null | undefined): boolean {
  return topic?.trim() === NEEDS_REVIEW_TOPIC
}

export function isOtherNotesTopic(topic: string | null | undefined): boolean {
  return topic?.trim() === OTHER_NOTES_TOPIC
}

export function isGenericSectionTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim() ?? ''
  return GENERIC_SECTION_TITLES.has(trimmed) || trimmed === OTHER_NOTES_TOPIC
}

function sameLabel(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
}

function compactLabel(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

const TOPIC_EMDASH = /^(.{1,80}?) (?:—|–| - ) (.+)$/u

/** Topic chips that would only repeat a heading the reader already sees. */
export function displayTopicLabel(
  topic: string | null | undefined,
  context: { sectionTitle?: string | null; itemTitle?: string | null } = {}
): string | null {
  const value = topic?.trim() ?? ''
  if (!value || isNeedsReviewTopic(value) || value === OTHER_NOTES_TOPIC) return null
  if (context.sectionTitle && sameLabel(value, context.sectionTitle)) return null
  if (context.itemTitle && sameLabel(value, context.itemTitle)) return null
  return value
}

export function stripTopicPrefix(line: string): string {
  const trimmed = line.replace(/\s+/gu, ' ').trim()
  const match = TOPIC_EMDASH.exec(trimmed)
  if (!match) return trimmed
  const topic = match[1]?.trim() ?? ''
  const rest = match[2]?.trim() ?? ''
  if (!rest || topic.includes('.') || topic.length > 60) return trimmed
  return rest
}

/** One short recap. Drops "Topic — body" prefixes and extra highlight lines. */
export function normalizeCustomerOverview(text: string | null | undefined): string {
  if (!text?.trim()) return ''
  const lines = text
    .split(/\n+/u)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line.length > 0)
  if (!lines.some((line) => stripTopicPrefix(line) !== line)) return text.trim()
  return lines.map(stripTopicPrefix).filter((line) => line.length > 0).slice(0, 2).join(' ')
}

export function distinctNoteTitle(
  title: string | null | undefined,
  body: string,
  context: { sectionTitle?: string | null; topic?: string | null } = {}
): string | null {
  const heading = title?.trim() ?? ''
  const text = body.replace(/\s+/gu, ' ').trim()
  if (!heading) return null
  if (sameLabel(heading, text)) return null
  if (context.sectionTitle && sameLabel(heading, context.sectionTitle)) return null
  if (context.topic && sameLabel(heading, context.topic)) return null
  const headingKey = compactLabel(heading)
  const bodyKey = compactLabel(text)
  const headingWords = headingKey.split(' ').filter(Boolean)
  const bodyWords = bodyKey.split(' ').filter(Boolean)
  if (
    headingWords.length >= 4 &&
    bodyKey.startsWith(`${headingKey} `) &&
    headingWords.length / Math.max(bodyWords.length, 1) >= 0.75
  ) {
    return null
  }
  return heading
}

interface CustomerNoteItem {
  title?: string | null
  text: string
  topic?: string | null
}

interface CustomerNotes {
  overview?: { text: string } | null
  keyTakeaways: CustomerNoteItem[]
  sections: Array<{
    title: string
    keyPoints: CustomerNoteItem[]
    supportingDetails: CustomerNoteItem[]
  }>
  decisions: CustomerNoteItem[]
  nextSteps: CustomerNoteItem[]
}

function keepVisibleItem<T extends CustomerNoteItem>(item: T): boolean {
  return !isNeedsReviewTopic(item.topic)
}

function cleanItem<T extends CustomerNoteItem>(
  item: T,
  sectionTitle?: string | null,
  keepTopic = false
): T {
  return {
    ...item,
    title: distinctNoteTitle(item.title, item.text, { sectionTitle, topic: item.topic }),
    topic: keepTopic
      ? displayTopicLabel(item.topic, { sectionTitle, itemTitle: item.title })
      : null
  }
}

/** Reader-facing notes: no leftover review bucket, no repeated topic/title chrome. */
export function toCustomerFacingNotes<T extends CustomerNotes>(notes: T): T {
  const overview = notes.overview
    ? { ...notes.overview, text: normalizeCustomerOverview(notes.overview.text) }
    : notes.overview
  return {
    ...notes,
    overview: overview && overview.text ? overview : null,
    keyTakeaways: notes.keyTakeaways.filter(keepVisibleItem).map((item) => cleanItem(item)),
    sections: notes.sections
      .filter((section) => !isNeedsReviewTopic(section.title))
      .map((section) => ({
        ...section,
        keyPoints: section.keyPoints.map((item) => cleanItem(item, section.title, true)),
        supportingDetails: section.supportingDetails.map((item) => cleanItem(item, section.title, true))
      }))
      .sort((left, right) => Number(isOtherNotesTopic(left.title)) - Number(isOtherNotesTopic(right.title))),
    decisions: notes.decisions.filter(keepVisibleItem).map((item) => cleanItem(item, null, true)),
    nextSteps: notes.nextSteps.filter(keepVisibleItem).map((item) => cleanItem(item, null, true))
  }
}
