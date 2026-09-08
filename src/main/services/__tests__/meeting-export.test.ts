import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { NormalizedNoteItem, NormalizedNotes } from '../../../shared/types'
import {
  createMeetingExportSuggestedFilename,
  hasMeetingExportNotes,
  meetingExportExtension,
  renderMeetingExportDocx,
  renderMeetingExportHtml,
  renderMeetingExportMarkdown,
  renderMeetingExportPlainText,
  type MeetingExportSnapshot
} from '../meeting-export'

const item = (
  id: string,
  text: string,
  overrides: Partial<NormalizedNoteItem> = {}
): NormalizedNoteItem => ({
  id,
  title: `${id}_TITLE`,
  topic: `${id}_TOPIC`,
  owner: `${id}_OWNER`,
  deadline: `${id}_DEADLINE`,
  completed: false,
  text,
  sources: [{ startMs: 1_001, endMs: 2_002 }],
  provenance: 'generated',
  legacySource: null,
  ...overrides
})

const notes: NormalizedNotes = {
  normalizedSchemaVersion: 1,
  meetingId: 'NOTES_MEETING_ID_INTERNAL',
  source: { format: 'notes-v2', schemaVersion: 2 },
  sourceTranscriptRevision: 'transcript-sha256:TRANSCRIPT_REVISION_INTERNAL',
  sourceAttributionRevision: 'notes-attribution-sha256:ATTRIBUTION_REVISION_INTERNAL',
  revision: 'sha256:NOTES_REVISION_INTERNAL',
  overview: {
    text: 'OVERVIEW_TEXT_VISIBLE',
    sources: [{ startMs: 3_003, endMs: 4_004 }],
    provenance: 'user-edited'
  },
  keyTakeaways: [
    item('TAKEAWAY_ID_INTERNAL', 'TAKEAWAY_TEXT_VISIBLE', {
      title: 'TAKEAWAY_TITLE_VISIBLE',
      topic: 'TAKEAWAY_TOPIC_VISIBLE',
      owner: 'TAKEAWAY_OWNER_VISIBLE',
      deadline: 'TAKEAWAY_DEADLINE_VISIBLE',
      sources: [{ startMs: 5_005, endMs: 6_006 }],
      provenance: 'legacy',
      legacySource: {
        adapterVersion: 1,
        bucket: 'decisions',
        itemIndex: 7,
        segmentId: 'LEGACY_SEGMENT_ID_INTERNAL',
        meetingId: 'LEGACY_MEETING_ID_INTERNAL',
        category: 'decision',
        topic: 'LEGACY_TOPIC_INTERNAL',
        sourceStartMs: 7_007,
        sourceEndMs: 8_008
      }
    })
  ],
  sections: [
    {
      id: 'SECTION_ID_INTERNAL',
      title: 'SECTION_TITLE_VISIBLE',
      summary: {
        text: 'SECTION_SUMMARY_VISIBLE',
        sources: [{ startMs: 9_009, endMs: 10_010 }],
        provenance: 'user-created'
      },
      keyPoints: [
        item('KEY_POINT_ID_INTERNAL', 'KEY_POINT_TEXT_VISIBLE', {
          title: null,
          topic: null,
          owner: null,
          deadline: null,
          sources: [{ startMs: 11_011, endMs: 12_012 }]
        })
      ],
      supportingDetails: [
        item('SUPPORTING_ID_INTERNAL', 'SUPPORTING_TEXT_VISIBLE', {
          title: 'SUPPORTING_TITLE_VISIBLE',
          topic: 'SUPPORTING_TOPIC_VISIBLE',
          owner: 'SUPPORTING_OWNER_VISIBLE',
          deadline: 'SUPPORTING_DEADLINE_VISIBLE',
          provenance: 'user-edited',
          sources: [{ startMs: 13_013, endMs: 14_014 }]
        })
      ]
    }
  ],
  decisions: [
    item('DECISION_ID_INTERNAL', 'DECISION_TEXT_VISIBLE', {
      title: 'DECISION_TITLE_VISIBLE',
      sources: [{ startMs: 15_015, endMs: 16_016 }]
    })
  ],
  nextSteps: [
    item('NEXT_STEP_ID_INTERNAL', 'NEXT_STEP_TEXT_VISIBLE', {
      title: 'NEXT_STEP_TITLE_VISIBLE',
      completed: true,
      sources: [{ startMs: 17_017, endMs: 18_018 }]
    })
  ]
}

const snapshot: MeetingExportSnapshot = {
  detail: {
    title: 'MEETING_TITLE_VISIBLE',
    sourceName: 'SOURCE_NAME_VISIBLE',
    date: Date.UTC(2026, 4, 6, 14, 7, 8),
    durationSeconds: 3_661
  },
  notes
}

const visibleNoteContent = [
  'OVERVIEW_TEXT_VISIBLE',
  'TAKEAWAY_TITLE_VISIBLE',
  'TAKEAWAY_TEXT_VISIBLE',
  'TAKEAWAY_OWNER_VISIBLE',
  'TAKEAWAY_DEADLINE_VISIBLE',
  'SECTION_TITLE_VISIBLE',
  'SECTION_SUMMARY_VISIBLE',
  'KEY_POINT_TEXT_VISIBLE',
  'SUPPORTING_TITLE_VISIBLE',
  'SUPPORTING_TEXT_VISIBLE',
  'SUPPORTING_TOPIC_VISIBLE',
  'SUPPORTING_OWNER_VISIBLE',
  'SUPPORTING_DEADLINE_VISIBLE',
  'DECISION_TITLE_VISIBLE',
  'DECISION_TEXT_VISIBLE',
  'NEXT_STEP_TITLE_VISIBLE',
  'NEXT_STEP_TEXT_VISIBLE'
]

const internalContent = [
  'NOTES_MEETING_ID_INTERNAL',
  'TRANSCRIPT_REVISION_INTERNAL',
  'ATTRIBUTION_REVISION_INTERNAL',
  'NOTES_REVISION_INTERNAL',
  'TAKEAWAY_ID_INTERNAL',
  'LEGACY_SEGMENT_ID_INTERNAL',
  'LEGACY_MEETING_ID_INTERNAL',
  'LEGACY_TOPIC_INTERNAL',
  'SECTION_ID_INTERNAL',
  'TRANSCRIPT_TEXT_PRIVATE',
  'SPEAKER_LABEL_PRIVATE',
  'SPEAKER_SUGGESTION_PRIVATE',
  'RAW_RECORD_PRIVATE'
]

function withIgnoredPrivateData(value: MeetingExportSnapshot): MeetingExportSnapshot {
  return {
    ...value,
    transcript: [{ text: 'TRANSCRIPT_TEXT_PRIVATE' }],
    speakers: {
      'speaker-1': { label: 'SPEAKER_LABEL_PRIVATE', suggestions: ['SPEAKER_SUGGESTION_PRIVATE'] }
    },
    rawRecord: 'RAW_RECORD_PRIVATE'
  } as MeetingExportSnapshot
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const endOffset = buffer.lastIndexOf(endSignature)
  if (endOffset < 0) throw new Error('Missing ZIP end-of-central-directory record')

  const entryCount = buffer.readUInt16LE(endOffset + 10)
  let offset = buffer.readUInt32LE(endOffset + 16)
  const entries = new Map<string, Buffer>()

  for (let index = 0; index < entryCount; index += 1) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50)
    const compression = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8')

    expect(buffer.readUInt32LE(localHeaderOffset)).toBe(0x04034b50)
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28)
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
    entries.set(name, compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed))

    offset += 46 + fileNameLength + extraLength + commentLength
  }
  return entries
}

function xml(entries: Map<string, Buffer>, path: string): string {
  const entry = entries.get(path)
  if (!entry) throw new Error(`Missing DOCX entry: ${path}`)
  return entry.toString('utf8')
}

describe('meeting export renderers', () => {
  it('renders every human-readable notes field in Markdown without private source records', () => {
    const markdown = renderMeetingExportMarkdown(withIgnoredPrivateData(snapshot))
    const readable = markdown.replace(/\\/g, '')

    expect(readable).toContain('# MEETING_TITLE_VISIBLE')
    expect(readable).toContain('May 6, 2026 at 2:07 PM UTC')
    expect(readable).toContain('SOURCE_NAME_VISIBLE')
    expect(readable).toContain('1h 1m 1s')
    expect(readable).toContain('[x]')
    for (const visible of visibleNoteContent) expect(readable).toContain(visible)
    for (const internal of internalContent) expect(markdown).not.toContain(internal)
    expect(markdown).not.toContain('Transcript')
    expect(markdown).not.toContain('Full-fidelity Record')
    expect(markdown).not.toContain('```json')
  })

  it('emits semantic print-ready notes HTML with the established memo styling', () => {
    const html = renderMeetingExportHtml(withIgnoredPrivateData(snapshot))

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<main>')
    expect(html).toContain('<header class="masthead">')
    expect(html).toContain('<section aria-labelledby="notes">')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('@page { size: Letter portrait; margin: 1in; }')
    expect(html).toContain('--paper: #FAFAF7')
    expect(html).toContain('--sage: #7A9E7E')
    for (const visible of visibleNoteContent) expect(html).toContain(visible)
    for (const internal of internalContent) expect(html).not.toContain(internal)
    expect(html).not.toContain('id="transcript"')
    expect(html).not.toContain('Full-fidelity Record')
  })

  it('renders generated heading and bold markers in rich outputs but keeps Markdown source', async () => {
    const formatted: MeetingExportSnapshot = {
      ...snapshot,
      notes: {
        ...notes,
        overview: {
          ...notes.overview!,
          text: '## Launch status\n**Retention** improved after onboarding changes.'
        },
        sections: [
          {
            ...notes.sections[0],
            title: '## Adoption',
            summary: {
              ...notes.sections[0].summary!,
              text: '**Activation** is trending upward.'
            },
            keyPoints: [
              {
                ...notes.sections[0].keyPoints[0],
                text: '**Trial starts** increased week over week.'
              }
            ]
          }
        ]
      }
    }

    const markdown = renderMeetingExportMarkdown(formatted)
    expect(markdown).toContain('## Launch status')
    expect(markdown).toContain('**Retention**')

    const plainText = renderMeetingExportPlainText(formatted)
    expect(plainText).toContain('Launch status\nRetention improved')
    expect(plainText).not.toContain('##')
    expect(plainText).not.toContain('**')

    const html = renderMeetingExportHtml(formatted)
    expect(html).toContain('<strong class="embedded-heading">Launch status</strong>')
    expect(html).toContain('<strong>Retention</strong> improved')
    expect(html).toContain('<h3 id="note-section-1">Adoption</h3>')
    expect(html).not.toContain('## Launch status')
    expect(html).not.toContain('**Retention**')

    const documentXml = xml(
      readZipEntries(await renderMeetingExportDocx(formatted)),
      'word/document.xml'
    )
    expect(documentXml).toContain('Launch status')
    expect(documentXml).toContain('Retention')
    expect(documentXml).toContain('<w:b')
    expect(documentXml).not.toContain('## Launch status')
    expect(documentXml).not.toContain('**Retention**')
  })

  it('escapes untrusted meeting and note content in Markdown, HTML, and DOCX XML', async () => {
    const unsafe: MeetingExportSnapshot = {
      ...snapshot,
      detail: {
        ...snapshot.detail,
        title: '<script>alert("title & more")</script> *title*\u0001\ud800'
      },
      notes: {
        ...notes,
        overview: {
          ...notes.overview!,
          text: 'A & B <tag attr="value"> _note_ [link](javascript:alert(1))'
        }
      }
    }

    const markdown = renderMeetingExportMarkdown(unsafe)
    expect(markdown).not.toContain('<script>')
    expect(markdown).toContain('&lt;script&gt;')
    expect(markdown).toContain('&amp;')
    expect(markdown).toContain('\\*title\\*')
    expect(markdown).toContain('\\[link\\]\\(javascript:alert\\(1\\)\\)')

    const html = renderMeetingExportHtml(unsafe)
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('</w:t>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;value&quot;')

    const entries = readZipEntries(await renderMeetingExportDocx(unsafe))
    const documentXml = xml(entries, 'word/document.xml')
    expect(documentXml).not.toContain('<script>')
    expect(documentXml).not.toContain('</w:t><script>')
    expect(documentXml).toContain('&lt;script&gt;')
    expect(documentXml).toContain('&amp;')
    expect(documentXml).not.toContain('\u0001')
    expect(documentXml).not.toContain('\ud800')
    expect(documentXml).toContain('\ufffd')
    expect(xml(entries, 'docProps/core.xml')).toContain('\ufffd')
  })

  it('builds a deterministic valid DOCX containing notes but no source internals', async () => {
    const privateSnapshot = withIgnoredPrivateData(snapshot)
    const [first, second] = await Promise.all([
      renderMeetingExportDocx(privateSnapshot),
      renderMeetingExportDocx(privateSnapshot)
    ])
    expect(first.equals(second)).toBe(true)
    expect(first.subarray(0, 4).toString('hex')).toBe('504b0304')

    const entries = readZipEntries(first)
    const contentTypes = xml(entries, '[Content_Types].xml')
    const documentXml = xml(entries, 'word/document.xml')
    const stylesXml = xml(entries, 'word/styles.xml')
    const numberingXml = xml(entries, 'word/numbering.xml')
    const footerXml = xml(entries, 'word/footer1.xml')
    const coreXml = xml(entries, 'docProps/core.xml')

    expect(contentTypes).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    )
    expect(documentXml).toContain('AUTODOC MEETING MEMO')
    for (const visible of visibleNoteContent) expect(documentXml).toContain(visible)
    for (const internal of internalContent) expect(documentXml).not.toContain(internal)
    expect(documentXml).not.toContain('Transcript')
    expect(documentXml).not.toContain('Full-fidelity Record')
    expect(documentXml).toContain('w:val="Heading1"')
    expect(documentXml).toContain('w:val="MastheadRule"')
    expect(documentXml).toMatch(/<w:pgSz[^>]*w:w="12240"[^>]*w:h="15840"/)
    expect(documentXml).toMatch(
      /<w:pgMar[^>]*w:top="1440"[^>]*w:right="1440"[^>]*w:bottom="1440"[^>]*w:left="1440"[^>]*w:header="708"[^>]*w:footer="708"/
    )

    expect(stylesXml).toContain('w:styleId="MastheadKicker"')
    expect(stylesXml).not.toContain('w:styleId="TechnicalRecord"')
    expect(stylesXml).not.toContain('w:styleId="TranscriptLabel"')
    expect(stylesXml).toContain('w:color w:val="4A6B4E"')
    expect(stylesXml).toContain('w:spacing w:after="120" w:line="300" w:lineRule="auto"')
    expect(numberingXml).toContain('w:numFmt w:val="bullet"')
    expect(numberingXml).toContain('w:lvlText w:val="•"')
    expect(numberingXml).toContain('w:ind w:left="540" w:hanging="270"')
    expect(footerXml).toContain('PAGE')
    expect(coreXml).toContain('<dc:creator>AutoDoc</dc:creator>')
    expect(coreXml).toContain('2026-05-06T14:07:08.000Z')
  })

  it('strips topic-prefix overview, repeated takeaway headings, and Key points labels', () => {
    const messy: MeetingExportSnapshot = {
      ...snapshot,
      notes: {
        ...notes,
        overview: {
          ...notes.overview!,
          text: [
            'Cancellations — The data indicates 14 starts and 6 cancellations.',
            'Minimum RAM requirement updated for Autodoc — Raised Windows minimum RAM to 16 GB.',
            'Granola format limitations — Local models struggle with formatting.'
          ].join('\n')
        },
        keyTakeaways: [
          item('takeaway-cancels', 'The data indicates 14 starts and 6 cancellations.', {
            title: 'Cancellations',
            topic: 'Cancellations',
            owner: null,
            deadline: null
          })
        ],
        sections: [
          {
            id: 'section-cancels',
            title: 'Cancellations',
            summary: null,
            keyPoints: [
              item('point-cancels', 'The data indicates 14 starts and 6 cancellations.', {
                title: 'The data indicates 14 starts and 6 cancellations.',
                topic: 'Cancellations',
                owner: null,
                deadline: null
              })
            ],
            supportingDetails: []
          }
        ],
        decisions: [],
        nextSteps: []
      }
    }

    const plainText = renderMeetingExportPlainText(messy)
    expect(plainText).toContain(
      'The data indicates 14 starts and 6 cancellations. Raised Windows minimum RAM to 16 GB.'
    )
    expect(plainText).not.toContain('Cancellations —')
    expect(plainText).not.toContain('Granola format limitations')
    expect(plainText).not.toContain('Topic: Cancellations')
    expect(plainText).not.toContain('Key points')
    expect(plainText.match(/^- The data indicates 14 starts/gmu)).toHaveLength(2)

    const html = renderMeetingExportHtml(messy)
    expect(html).not.toContain('<h4>Key points</h4>')
    expect(html).not.toContain('Topic: Cancellations')
  })

  it('renders a quiet empty state when no normalized notes are present', async () => {
    const empty: MeetingExportSnapshot = { ...snapshot, notes: null }

    expect(renderMeetingExportMarkdown(empty)).toContain('No notes are available')
    expect(renderMeetingExportPlainText(empty)).toContain('No notes are available')
    expect(renderMeetingExportHtml(empty)).toContain('No notes are available')
    expect(
      xml(readZipEntries(await renderMeetingExportDocx(empty)), 'word/document.xml')
    ).toContain('No notes are available')
  })
})

describe('hasMeetingExportNotes', () => {
  const emptyNotes: NormalizedNotes = {
    ...notes,
    overview: null,
    keyTakeaways: [],
    sections: [],
    decisions: [],
    nextSteps: []
  }

  it('rejects null, structurally empty, whitespace-only, and section-title-only notes', () => {
    expect(hasMeetingExportNotes({ ...snapshot, notes: null })).toBe(false)
    expect(hasMeetingExportNotes({ ...snapshot, notes: emptyNotes })).toBe(false)
    expect(
      hasMeetingExportNotes({
        ...snapshot,
        notes: {
          ...emptyNotes,
          overview: { text: '   ', sources: [], provenance: 'user-created' }
        }
      })
    ).toBe(false)
    expect(
      hasMeetingExportNotes({
        ...snapshot,
        notes: {
          ...emptyNotes,
          sections: [
            {
              id: 'empty-section',
              title: 'A title without note content',
              summary: null,
              keyPoints: [],
              supportingDetails: []
            }
          ]
        }
      })
    ).toBe(false)
  })

  it('accepts human-readable overview, item metadata, and section content', () => {
    expect(hasMeetingExportNotes(snapshot)).toBe(true)
    expect(
      hasMeetingExportNotes({
        ...snapshot,
        notes: {
          ...emptyNotes,
          decisions: [item('metadata-only', '', { title: null, topic: null, owner: 'Chris' })]
        }
      })
    ).toBe(true)
    expect(
      hasMeetingExportNotes({
        ...snapshot,
        notes: {
          ...emptyNotes,
          sections: [
            {
              id: 'summary-section',
              title: 'Section',
              summary: { text: 'Summary', sources: [], provenance: 'user-created' },
              keyPoints: [],
              supportingDetails: []
            }
          ]
        }
      })
    ).toBe(true)
  })
})

describe('meeting export filenames', () => {
  it('maps formats to native extensions', () => {
    expect(meetingExportExtension('markdown')).toBe('md')
    expect(meetingExportExtension('pdf')).toBe('pdf')
    expect(meetingExportExtension('docx')).toBe('docx')
  })

  it('creates short filesystem-safe names without a presentation variant suffix', () => {
    expect(createMeetingExportSuggestedFilename('  Q3: Roadmap / Review?  ', 'markdown')).toBe(
      'Q3 Roadmap Review.md'
    )
    expect(createMeetingExportSuggestedFilename('CON', 'docx')).toBe('Meeting CON.docx')
    expect(createMeetingExportSuggestedFilename('con.txt', 'pdf')).toBe('Meeting con.txt.pdf')
    expect(createMeetingExportSuggestedFilename('... ', 'pdf')).toBe('Untitled Meeting.pdf')
    expect(
      Buffer.byteLength(createMeetingExportSuggestedFilename('📝'.repeat(200), 'docx'), 'utf8')
    ).toBeLessThanOrEqual(120)
    expect(createMeetingExportSuggestedFilename('Roadmap', 'docx')).not.toContain('Full')
  })
})
