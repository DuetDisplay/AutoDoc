import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  TextRun
} from 'docx'
import type {
  MeetingExportFormat,
  MeetingExportVariant,
  NormalizedNoteItem,
  NormalizedNotes,
  SpeakerMap,
  Transcript
} from '../../shared/types'

export interface MeetingExportSnapshot {
  detail: {
    title: string
    sourceName: string | null
    date: number
    durationSeconds: number | null
  }
  notes: NormalizedNotes | null
  transcript: Transcript[]
  speakers: SpeakerMap
}

const PALETTE = {
  paper: 'FAFAF7',
  surface: 'FFFFFF',
  ink: '1A1A17',
  secondaryInk: '3D3B37',
  muted: '6B6A63',
  faint: '9C9B94',
  sage: '7A9E7E',
  sageDark: '4A6B4E',
  sageLight: 'E8F0E8',
  border: 'D9D8D0'
} as const

const BULLET_REFERENCE = 'autodoc-export-bullets'
const PAGE_WIDTH_DXA = 12_240
const PAGE_HEIGHT_DXA = 15_840
const PAGE_MARGIN_DXA = 1_440
const HEADER_FOOTER_DXA = 708

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    )
  }
  return String(value)
}

function fullRecordJson(snapshot: MeetingExportSnapshot): string {
  return JSON.stringify(canonicalize(snapshot), null, 2)
}

function markdownSafeJson(snapshot: MeetingExportSnapshot): string {
  return fullRecordJson(snapshot).replace(/[<>&\u2028\u2029]/g, (character) => {
    const codePoint = character.charCodeAt(0).toString(16).padStart(4, '0')
    return `\\u${codePoint}`
  })
}

function markdownJsonFence(json: string): string {
  const longestRun = Math.max(0, ...Array.from(json.matchAll(/`+/g), (match) => match[0].length))
  return '`'.repeat(Math.max(3, longestRun + 1))
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function xmlSafeText(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    const valid =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    return valid ? character : '\ufffd'
  }).join('')
}

function escapeXml(value: string): string {
  return escapeHtml(xmlSafeText(value))
}

function escapeMarkdown(value: string): string {
  const htmlSafe = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  return Array.from(htmlSafe, (character) =>
    '\\`*_{}[]()#+.!|~-'.includes(character) ? `\\${character}` : character
  )
    .join('')
    .replace(/\r\n?|\n/g, '  \n  ')
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) return 'Unknown date'

  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ]
  const hours = date.getUTCHours()
  const hour = hours % 12 || 12
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const meridiem = hours < 12 ? 'AM' : 'PM'
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} at ${hour}:${minute} ${meridiem} UTC`
}

function formatDuration(durationSeconds: number | null): string {
  if (durationSeconds === null || !Number.isFinite(durationSeconds)) return 'Unknown duration'
  const total = Math.max(0, Math.round(durationSeconds))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  return [hours ? `${hours}h` : '', minutes || hours ? `${minutes}m` : '', `${seconds}s`]
    .filter(Boolean)
    .join(' ')
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function speakerLabel(snapshot: MeetingExportSnapshot, transcript: Transcript): string {
  return (
    snapshot.speakers[transcript.speaker]?.label?.trim() || transcript.speaker || 'Unknown speaker'
  )
}

function itemMetadata(item: NormalizedNoteItem): string[] {
  return [
    item.topic ? `Topic: ${item.topic}` : '',
    item.owner ? `Owner: ${item.owner}` : '',
    item.deadline ? `Due: ${item.deadline}` : ''
  ].filter(Boolean)
}

function markdownItem(item: NormalizedNoteItem, checklist: boolean): string {
  const checkbox = checklist ? `[${item.completed ? 'x' : ' '}] ` : ''
  const title = item.title ? `**${escapeMarkdown(item.title)}** — ` : ''
  const metadata = itemMetadata(item)
  const suffix = metadata.length ? ` _(${metadata.map(escapeMarkdown).join(' · ')})_` : ''
  return `- ${checkbox}${title}${escapeMarkdown(item.text)}${suffix}`
}

function renderMarkdownNotes(snapshot: MeetingExportSnapshot): string[] {
  const { notes } = snapshot
  if (!notes) return ['## Notes', '', '_No notes are available for this meeting._', '']

  const lines = ['## Notes', '']
  if (notes.overview) {
    lines.push('### Overview', '', escapeMarkdown(notes.overview.text), '')
  }
  if (notes.keyTakeaways.length) {
    lines.push(
      '### Key Takeaways',
      '',
      ...notes.keyTakeaways.map((item) => markdownItem(item, false)),
      ''
    )
  }
  for (const section of notes.sections) {
    lines.push(`### ${escapeMarkdown(section.title)}`, '')
    if (section.summary) lines.push(escapeMarkdown(section.summary.text), '')
    if (section.keyPoints.length) {
      lines.push(
        '**Key points**',
        '',
        ...section.keyPoints.map((item) => markdownItem(item, false)),
        ''
      )
    }
    if (section.supportingDetails.length) {
      lines.push(
        '**Supporting details**',
        '',
        ...section.supportingDetails.map((item) => markdownItem(item, false)),
        ''
      )
    }
  }
  if (notes.decisions.length) {
    lines.push('### Decisions', '', ...notes.decisions.map((item) => markdownItem(item, false)), '')
  }
  if (notes.nextSteps.length) {
    lines.push('### Next Steps', '', ...notes.nextSteps.map((item) => markdownItem(item, true)), '')
  }
  if (lines.length === 2) lines.push('_No note content is available for this meeting._', '')
  return lines
}

function renderMarkdownTranscript(snapshot: MeetingExportSnapshot): string[] {
  const lines = ['## Transcript', '']
  if (!snapshot.transcript.length)
    return [...lines, '_No transcript is available for this meeting._', '']

  for (const entry of snapshot.transcript) {
    lines.push(
      `**${escapeMarkdown(speakerLabel(snapshot, entry))}** _(${formatTimestamp(entry.startMs)}–${formatTimestamp(entry.endMs)})_`,
      '',
      escapeMarkdown(entry.text),
      ''
    )
  }
  return lines
}

export function renderMeetingExportMarkdown(
  snapshot: MeetingExportSnapshot,
  variant: MeetingExportVariant
): string {
  const lines = [
    'AUTODOC MEETING MEMO',
    '',
    `# ${escapeMarkdown(snapshot.detail.title || 'Untitled Meeting')}`,
    '',
    `**Date:** ${escapeMarkdown(formatDate(snapshot.detail.date))}`,
    `**Source:** ${escapeMarkdown(snapshot.detail.sourceName || 'Not specified')}`,
    `**Duration:** ${escapeMarkdown(formatDuration(snapshot.detail.durationSeconds))}`,
    '',
    '---',
    '',
    ...renderMarkdownNotes(snapshot),
    ...renderMarkdownTranscript(snapshot)
  ]

  if (variant === 'full') {
    const record = markdownSafeJson(snapshot)
    const fence = markdownJsonFence(record)
    lines.push(
      '## Full-fidelity Record',
      '',
      'This appendix preserves the normalized notes, revisions, provenance, source ranges, legacy origins, raw transcript fields, and speaker registry.',
      '',
      `${fence}json`,
      record,
      fence,
      ''
    )
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

function htmlText(value: string): string {
  return escapeHtml(value).replace(/\r\n?|\n/g, '<br>')
}

function htmlItem(item: NormalizedNoteItem, checklist: boolean): string {
  const checked = checklist
    ? `<span class="check" aria-hidden="true">${item.completed ? '✓' : '○'}</span>`
    : ''
  const title = item.title
    ? `<strong>${htmlText(item.title)}</strong><span aria-hidden="true"> — </span>`
    : ''
  const metadata = itemMetadata(item)
  const suffix = metadata.length
    ? `<small>${metadata.map(htmlText).join(' <span aria-hidden="true">·</span> ')}</small>`
    : ''
  return `<li>${checked}<span>${title}${htmlText(item.text)}${suffix}</span></li>`
}

function renderHtmlNotes(snapshot: MeetingExportSnapshot): string {
  const { notes } = snapshot
  if (!notes) {
    return '<section aria-labelledby="notes"><h2 id="notes">Notes</h2><p class="empty">No notes are available for this meeting.</p></section>'
  }

  const content: string[] = ['<section aria-labelledby="notes"><h2 id="notes">Notes</h2>']
  if (notes.overview) {
    content.push(
      `<section aria-labelledby="overview"><h3 id="overview">Overview</h3><p>${htmlText(notes.overview.text)}</p></section>`
    )
  }
  if (notes.keyTakeaways.length) {
    content.push(
      `<section aria-labelledby="takeaways"><h3 id="takeaways">Key Takeaways</h3><ul>${notes.keyTakeaways.map((item) => htmlItem(item, false)).join('')}</ul></section>`
    )
  }
  notes.sections.forEach((section, index) => {
    const id = `note-section-${index + 1}`
    content.push(`<section aria-labelledby="${id}"><h3 id="${id}">${htmlText(section.title)}</h3>`)
    if (section.summary) content.push(`<p>${htmlText(section.summary.text)}</p>`)
    if (section.keyPoints.length) {
      content.push(
        `<h4>Key points</h4><ul>${section.keyPoints.map((item) => htmlItem(item, false)).join('')}</ul>`
      )
    }
    if (section.supportingDetails.length) {
      content.push(
        `<h4>Supporting details</h4><ul>${section.supportingDetails.map((item) => htmlItem(item, false)).join('')}</ul>`
      )
    }
    content.push('</section>')
  })
  if (notes.decisions.length) {
    content.push(
      `<section aria-labelledby="decisions"><h3 id="decisions">Decisions</h3><ul>${notes.decisions.map((item) => htmlItem(item, false)).join('')}</ul></section>`
    )
  }
  if (notes.nextSteps.length) {
    content.push(
      `<section aria-labelledby="next-steps"><h3 id="next-steps">Next Steps</h3><ul class="checklist">${notes.nextSteps.map((item) => htmlItem(item, true)).join('')}</ul></section>`
    )
  }
  if (content.length === 1)
    content.push('<p class="empty">No note content is available for this meeting.</p>')
  content.push('</section>')
  return content.join('')
}

function renderHtmlTranscript(snapshot: MeetingExportSnapshot): string {
  if (!snapshot.transcript.length) {
    return '<section aria-labelledby="transcript"><h2 id="transcript">Transcript</h2><p class="empty">No transcript is available for this meeting.</p></section>'
  }

  const entries = snapshot.transcript
    .map(
      (entry, index) =>
        `<article class="utterance" aria-labelledby="speaker-${index + 1}"><header><strong id="speaker-${index + 1}">${htmlText(speakerLabel(snapshot, entry))}</strong><time>${formatTimestamp(entry.startMs)}–${formatTimestamp(entry.endMs)}</time></header><p>${htmlText(entry.text)}</p></article>`
    )
    .join('')
  return `<section aria-labelledby="transcript"><h2 id="transcript">Transcript</h2>${entries}</section>`
}

export function renderMeetingExportHtml(
  snapshot: MeetingExportSnapshot,
  variant: MeetingExportVariant
): string {
  const appendix =
    variant === 'full'
      ? `<section class="technical" aria-labelledby="full-record"><h2 id="full-record">Full-fidelity Record</h2><p>This appendix preserves the normalized notes, revisions, provenance, source ranges, legacy origins, raw transcript fields, and speaker registry.</p><pre><code>${escapeHtml(fullRecordJson(snapshot))}</code></pre></section>`
      : ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <title>${escapeHtml(snapshot.detail.title || 'Untitled Meeting')} — AutoDoc Meeting Memo</title>
  <style>
    :root { --paper: #${PALETTE.paper}; --surface: #${PALETTE.surface}; --ink: #${PALETTE.ink}; --secondary: #${PALETTE.secondaryInk}; --muted: #${PALETTE.muted}; --sage: #${PALETTE.sage}; --sage-dark: #${PALETTE.sageDark}; --sage-light: #${PALETTE.sageLight}; --border: #${PALETTE.border}; }
    @page { size: Letter portrait; margin: 1in; }
    * { box-sizing: border-box; }
    html { background: var(--paper); color: var(--ink); font-family: "DM Sans", "Avenir Next", Arial, sans-serif; font-size: 11pt; line-height: 1.5; }
    body { margin: 0; background: var(--paper); }
    main { width: min(7.5in, 100%); margin: 0 auto; padding: .8in .7in; background: var(--surface); }
    .masthead { border-bottom: 1px solid var(--sage); padding-bottom: 18pt; margin-bottom: 18pt; }
    .kicker { margin: 0 0 5pt; color: var(--sage-dark); font-size: 8.5pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0 0 12pt; color: var(--ink); font-family: "Instrument Serif", Georgia, serif; font-size: 25pt; font-weight: 500; line-height: 1.08; }
    h2 { margin: 18pt 0 10pt; color: var(--sage-dark); font-size: 16pt; line-height: 1.2; break-after: avoid; }
    h3 { margin: 14pt 0 7pt; color: var(--sage-dark); font-size: 13pt; line-height: 1.25; break-after: avoid; }
    h4 { margin: 10pt 0 5pt; color: var(--secondary); font-size: 11pt; line-height: 1.25; break-after: avoid; }
    p { margin: 0 0 6pt; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 3pt 14pt; margin: 0; }
    dt { color: var(--muted); font-weight: 700; }
    dd { margin: 0; color: var(--secondary); }
    ul { margin: 0 0 8pt; padding-left: 18pt; }
    li { margin: 0 0 4pt; padding-left: 2pt; break-inside: avoid; }
    li small { display: block; color: var(--muted); font-size: 9pt; }
    .checklist { list-style: none; padding-left: 0; }
    .checklist li { display: flex; gap: 7pt; }
    .check { color: var(--sage-dark); font-weight: 700; }
    .utterance { border-left: 2px solid var(--sage-light); margin: 0 0 10pt; padding-left: 10pt; break-inside: avoid; }
    .utterance header { display: flex; align-items: baseline; gap: 8pt; }
    .utterance strong { color: var(--secondary); }
    .utterance time { color: var(--muted); font-size: 8.5pt; }
    .utterance p { margin: 2pt 0 0; }
    .empty { color: var(--muted); font-style: italic; }
    .technical { margin-top: 18pt; }
    pre { overflow-wrap: anywhere; white-space: pre-wrap; border: 1px solid var(--border); border-left: 3px solid var(--sage); background: var(--paper); color: var(--secondary); padding: 10pt; font: 8pt/1.22 "JetBrains Mono", Consolas, monospace; }
    @media print { html, body, main { background: white; } main { width: auto; margin: 0; padding: 0; } a { color: inherit; text-decoration: none; } }
  </style>
</head>
<body>
  <main>
    <header class="masthead">
      <p class="kicker">AutoDoc Meeting Memo</p>
      <h1>${htmlText(snapshot.detail.title || 'Untitled Meeting')}</h1>
      <dl>
        <dt>Date</dt><dd>${htmlText(formatDate(snapshot.detail.date))}</dd>
        <dt>Source</dt><dd>${htmlText(snapshot.detail.sourceName || 'Not specified')}</dd>
        <dt>Duration</dt><dd>${htmlText(formatDuration(snapshot.detail.durationSeconds))}</dd>
      </dl>
    </header>
    ${renderHtmlNotes(snapshot)}
    ${renderHtmlTranscript(snapshot)}
    ${appendix}
  </main>
</body>
</html>`
}

function docxParagraph(text: string, style = 'Normal'): Paragraph {
  return new Paragraph({ style, children: [new TextRun(xmlSafeText(text))] })
}

function docxBullet(item: NormalizedNoteItem, checklist: boolean): Paragraph {
  const metadata = itemMetadata(item)
  const children: TextRun[] = []
  if (checklist)
    children.push(
      new TextRun({ text: item.completed ? '[x] ' : '[ ] ', color: PALETTE.sageDark, bold: true })
    )
  if (item.title) children.push(new TextRun({ text: xmlSafeText(`${item.title} — `), bold: true }))
  children.push(new TextRun(xmlSafeText(item.text)))
  if (metadata.length)
    children.push(
      new TextRun({
        text: xmlSafeText(`  ${metadata.join(' · ')}`),
        color: PALETTE.muted,
        italics: true,
        size: 18
      })
    )
  return new Paragraph({
    style: 'ListParagraph',
    numbering: { reference: BULLET_REFERENCE, level: 0 },
    children
  })
}

function docxNotes(snapshot: MeetingExportSnapshot): Paragraph[] {
  const paragraphs = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Notes')] })
  ]
  const { notes } = snapshot
  if (!notes)
    return [...paragraphs, docxParagraph('No notes are available for this meeting.', 'EmptyState')]

  if (notes.overview) {
    paragraphs.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Overview')] }),
      docxParagraph(notes.overview.text)
    )
  }
  if (notes.keyTakeaways.length) {
    paragraphs.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Key Takeaways')] })
    )
    paragraphs.push(...notes.keyTakeaways.map((item) => docxBullet(item, false)))
  }
  for (const section of notes.sections) {
    paragraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun(xmlSafeText(section.title))]
      })
    )
    if (section.summary) paragraphs.push(docxParagraph(section.summary.text))
    if (section.keyPoints.length) {
      paragraphs.push(
        new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun('Key points')] })
      )
      paragraphs.push(...section.keyPoints.map((item) => docxBullet(item, false)))
    }
    if (section.supportingDetails.length) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [new TextRun('Supporting details')]
        })
      )
      paragraphs.push(...section.supportingDetails.map((item) => docxBullet(item, false)))
    }
  }
  if (notes.decisions.length) {
    paragraphs.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Decisions')] })
    )
    paragraphs.push(...notes.decisions.map((item) => docxBullet(item, false)))
  }
  if (notes.nextSteps.length) {
    paragraphs.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Next Steps')] })
    )
    paragraphs.push(...notes.nextSteps.map((item) => docxBullet(item, true)))
  }
  if (paragraphs.length === 1)
    paragraphs.push(docxParagraph('No note content is available for this meeting.', 'EmptyState'))
  return paragraphs
}

function docxTranscript(snapshot: MeetingExportSnapshot): Paragraph[] {
  const paragraphs = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Transcript')] })
  ]
  if (!snapshot.transcript.length)
    return [
      ...paragraphs,
      docxParagraph('No transcript is available for this meeting.', 'EmptyState')
    ]

  for (const entry of snapshot.transcript) {
    paragraphs.push(
      new Paragraph({
        style: 'TranscriptLabel',
        children: [
          new TextRun({ text: xmlSafeText(speakerLabel(snapshot, entry)), bold: true }),
          new TextRun({
            text: `  ${formatTimestamp(entry.startMs)}–${formatTimestamp(entry.endMs)}`,
            color: PALETTE.muted,
            size: 18
          })
        ]
      }),
      docxParagraph(entry.text)
    )
  }
  return paragraphs
}

function deterministicCoreProperties(snapshot: MeetingExportSnapshot): string {
  const date = new Date(snapshot.detail.date)
  const timestamp =
    Number.isFinite(snapshot.detail.date) && !Number.isNaN(date.getTime())
      ? date.toISOString()
      : '1980-01-01T00:00:00.000Z'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(snapshot.detail.title || 'Untitled Meeting')}</dc:title><dc:subject>AutoDoc meeting export</dc:subject><dc:creator>AutoDoc</dc:creator><cp:lastModifiedBy>AutoDoc</cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`
}

function normalizeZipTimestamps(buffer: Buffer): Buffer {
  const normalized = Buffer.from(buffer)
  const dosTime = 0
  const dosDate = 33 // 1980-01-01

  // Locate the end-of-central-directory record from the end of the archive,
  // where the ZIP comment can add at most 65,535 bytes. Reading entry offsets
  // from the central directory avoids mistaking signature-like bytes inside a
  // compressed document part for a ZIP header.
  const minimumEndOffset = Math.max(0, normalized.length - 22 - 65_535)
  let endOffset = -1
  for (let index = normalized.length - 22; index >= minimumEndOffset; index -= 1) {
    if (
      normalized.readUInt32LE(index) === 0x06054b50 &&
      index + 22 + normalized.readUInt16LE(index + 20) === normalized.length
    ) {
      endOffset = index
      break
    }
  }
  if (endOffset < 0) throw new Error('Invalid DOCX archive')

  const entryCount = normalized.readUInt16LE(endOffset + 10)
  let centralOffset = normalized.readUInt32LE(endOffset + 16)
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (centralOffset + 46 > endOffset || normalized.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('Invalid DOCX archive')
    }

    const localOffset = normalized.readUInt32LE(centralOffset + 42)
    if (
      localOffset + 30 > normalized.length ||
      normalized.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throw new Error('Invalid DOCX archive')
    }

    normalized.writeUInt16LE(dosTime, localOffset + 10)
    normalized.writeUInt16LE(dosDate, localOffset + 12)
    normalized.writeUInt16LE(dosTime, centralOffset + 12)
    normalized.writeUInt16LE(dosDate, centralOffset + 14)

    centralOffset +=
      46 +
      normalized.readUInt16LE(centralOffset + 28) +
      normalized.readUInt16LE(centralOffset + 30) +
      normalized.readUInt16LE(centralOffset + 32)
  }
  return normalized
}

export async function renderMeetingExportDocx(
  snapshot: MeetingExportSnapshot,
  variant: MeetingExportVariant
): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ style: 'MastheadKicker', children: [new TextRun('AUTODOC MEETING MEMO')] }),
    new Paragraph({
      style: 'Title',
      children: [new TextRun(xmlSafeText(snapshot.detail.title || 'Untitled Meeting'))]
    }),
    new Paragraph({
      style: 'Metadata',
      children: [
        new TextRun({ text: 'Date: ', bold: true }),
        new TextRun(formatDate(snapshot.detail.date))
      ]
    }),
    new Paragraph({
      style: 'Metadata',
      children: [
        new TextRun({ text: 'Source: ', bold: true }),
        new TextRun(xmlSafeText(snapshot.detail.sourceName || 'Not specified'))
      ]
    }),
    new Paragraph({
      style: 'Metadata',
      children: [
        new TextRun({ text: 'Duration: ', bold: true }),
        new TextRun(formatDuration(snapshot.detail.durationSeconds))
      ]
    }),
    new Paragraph({ style: 'MastheadRule', children: [] }),
    ...docxNotes(snapshot),
    ...docxTranscript(snapshot)
  ]

  if (variant === 'full') {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun('Full-fidelity Record')]
      }),
      docxParagraph(
        'This appendix preserves the normalized notes, revisions, provenance, source ranges, legacy origins, raw transcript fields, and speaker registry.'
      ),
      ...fullRecordJson(snapshot)
        .split('\n')
        .map((line) => docxParagraph(line, 'TechnicalRecord'))
    )
  }

  const document = new Document({
    creator: 'AutoDoc',
    lastModifiedBy: 'AutoDoc',
    title: xmlSafeText(snapshot.detail.title || 'Untitled Meeting'),
    subject: 'AutoDoc meeting export',
    revision: 1,
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22, color: PALETTE.ink },
          paragraph: { spacing: { after: 120, line: 300, lineRule: LineRuleType.AUTO } }
        },
        title: {
          run: { font: 'Calibri', size: 46, bold: true, color: PALETTE.ink },
          paragraph: { spacing: { before: 0, after: 80 }, keepNext: true }
        },
        heading1: {
          run: { font: 'Calibri', size: 32, bold: true, color: PALETTE.sageDark },
          paragraph: { spacing: { before: 360, after: 200 }, keepNext: true, outlineLevel: 0 }
        },
        heading2: {
          run: { font: 'Calibri', size: 26, bold: true, color: PALETTE.sageDark },
          paragraph: { spacing: { before: 280, after: 140 }, keepNext: true, outlineLevel: 1 }
        },
        heading3: {
          run: { font: 'Calibri', size: 24, bold: true, color: PALETTE.secondaryInk },
          paragraph: { spacing: { before: 200, after: 100 }, keepNext: true, outlineLevel: 2 }
        },
        listParagraph: {
          run: { font: 'Calibri', size: 22, color: PALETTE.ink },
          paragraph: { spacing: { after: 80, line: 300, lineRule: LineRuleType.AUTO } }
        }
      },
      paragraphStyles: [
        {
          id: 'MastheadKicker',
          name: 'Masthead Kicker',
          basedOn: 'Normal',
          next: 'Title',
          quickFormat: true,
          run: {
            font: 'Calibri',
            size: 18,
            bold: true,
            allCaps: true,
            color: PALETTE.sageDark,
            characterSpacing: 24
          },
          paragraph: { spacing: { before: 0, after: 60 }, keepNext: true }
        },
        {
          id: 'Metadata',
          name: 'Metadata',
          basedOn: 'Normal',
          next: 'Metadata',
          quickFormat: true,
          run: { font: 'Calibri', size: 20, color: PALETTE.secondaryInk },
          paragraph: { spacing: { before: 0, after: 40, line: 240, lineRule: LineRuleType.AUTO } }
        },
        {
          id: 'MastheadRule',
          name: 'Masthead Rule',
          basedOn: 'Normal',
          next: 'Heading1',
          paragraph: {
            border: {
              bottom: { style: BorderStyle.SINGLE, color: PALETTE.sage, size: 6, space: 8 }
            },
            spacing: { before: 80, after: 80 }
          }
        },
        {
          id: 'TranscriptLabel',
          name: 'Transcript Label',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { font: 'Calibri', size: 20, color: PALETTE.secondaryInk },
          paragraph: { spacing: { before: 120, after: 20 }, keepNext: true }
        },
        {
          id: 'EmptyState',
          name: 'Empty State',
          basedOn: 'Normal',
          next: 'Normal',
          run: { font: 'Calibri', size: 22, color: PALETTE.muted, italics: true },
          paragraph: { spacing: { after: 120, line: 300, lineRule: LineRuleType.AUTO } }
        },
        {
          id: 'TechnicalRecord',
          name: 'Technical Record',
          basedOn: 'Normal',
          next: 'TechnicalRecord',
          run: { font: 'Consolas', size: 16, color: PALETTE.secondaryInk, noProof: true },
          paragraph: {
            spacing: { before: 0, after: 0, line: 180, lineRule: LineRuleType.AUTO },
            keepLines: true
          }
        }
      ]
    },
    numbering: {
      config: [
        {
          reference: BULLET_REFERENCE,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              alignment: AlignmentType.LEFT,
              style: {
                run: { font: 'Calibri', color: PALETTE.sageDark },
                paragraph: {
                  indent: { left: 540, hanging: 270 },
                  spacing: { after: 80, line: 300, lineRule: LineRuleType.AUTO }
                }
              }
            }
          ]
        }
      ]
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH_DXA, height: PAGE_HEIGHT_DXA },
            margin: {
              top: PAGE_MARGIN_DXA,
              right: PAGE_MARGIN_DXA,
              bottom: PAGE_MARGIN_DXA,
              left: PAGE_MARGIN_DXA,
              header: HEADER_FOOTER_DXA,
              footer: HEADER_FOOTER_DXA
            }
          }
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: 'AUTODOC / MEETING EXPORT',
                    color: PALETTE.faint,
                    size: 16,
                    bold: true
                  })
                ]
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: 'AutoDoc | ', color: PALETTE.faint, size: 16 }),
                  new TextRun({ children: [PageNumber.CURRENT], color: PALETTE.faint, size: 16 })
                ]
              })
            ]
          })
        },
        children
      }
    ]
  })

  const buffer = await Packer.toBuffer(document, true, [
    { path: 'docProps/core.xml', data: deterministicCoreProperties(snapshot) }
  ])
  return normalizeZipTimestamps(buffer)
}

export function meetingExportExtension(format: MeetingExportFormat): 'md' | 'pdf' | 'docx' {
  if (format === 'markdown') return 'md'
  return format
}

export function createMeetingExportSuggestedFilename(
  title: string,
  format: MeetingExportFormat,
  variant: MeetingExportVariant
): string {
  const cleaned = title
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  const windowsStem = cleaned.split('.', 1)[0]
  const withoutReservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(windowsStem)
    ? `Meeting ${cleaned}`
    : cleaned
  const suffix = variant === 'full' ? ' - Full' : ''
  const extension = `.${meetingExportExtension(format)}`
  const maxBaseBytes = 120 - Buffer.byteLength(suffix + extension, 'utf8')
  let base = ''
  for (const character of withoutReservedName || 'Untitled Meeting') {
    if (Buffer.byteLength(base + character, 'utf8') > maxBaseBytes) break
    base += character
  }
  base = base.trimEnd() || 'Untitled Meeting'
  return `${base}${suffix}${extension}`
}
