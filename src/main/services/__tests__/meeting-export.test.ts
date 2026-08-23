import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { NormalizedNoteItem, NormalizedNotes } from '../../../shared/types'
import {
  createMeetingExportSuggestedFilename,
  meetingExportExtension,
  renderMeetingExportDocx,
  renderMeetingExportHtml,
  renderMeetingExportMarkdown,
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
  meetingId: 'NOTES_MEETING_ID_SENTINEL',
  source: { format: 'notes-v2', schemaVersion: 2 },
  sourceTranscriptRevision: 'transcript-sha256:TRANSCRIPT_REVISION_SENTINEL',
  sourceAttributionRevision: 'notes-attribution-sha256:ATTRIBUTION_REVISION_SENTINEL',
  revision: 'sha256:NOTES_REVISION_SENTINEL',
  overview: {
    text: 'OVERVIEW_TEXT_SENTINEL',
    sources: [{ startMs: 3_003, endMs: 4_004 }],
    provenance: 'user-edited'
  },
  keyTakeaways: [
    item('TAKEAWAY_ID_SENTINEL', 'TAKEAWAY_TEXT_SENTINEL', {
      completed: true,
      sources: [{ startMs: 5_005, endMs: 6_006 }],
      provenance: 'legacy',
      legacySource: {
        adapterVersion: 1,
        bucket: 'decisions',
        itemIndex: 7,
        segmentId: 'LEGACY_SEGMENT_ID_SENTINEL',
        meetingId: 'LEGACY_MEETING_ID_SENTINEL',
        category: 'decision',
        topic: 'LEGACY_TOPIC_SENTINEL',
        sourceStartMs: 7_007,
        sourceEndMs: 8_008
      }
    })
  ],
  sections: [
    {
      id: 'SECTION_ID_SENTINEL',
      title: 'SECTION_TITLE_SENTINEL',
      summary: {
        text: 'SECTION_SUMMARY_SENTINEL',
        sources: [{ startMs: 9_009, endMs: 10_010 }],
        provenance: 'user-created'
      },
      keyPoints: [
        item('KEY_POINT_ID_SENTINEL', 'KEY_POINT_TEXT_SENTINEL', {
          title: null,
          topic: null,
          owner: null,
          deadline: null,
          completed: false,
          sources: [{ startMs: 11_011, endMs: 12_012 }]
        })
      ],
      supportingDetails: [
        item('SUPPORTING_ID_SENTINEL', 'SUPPORTING_TEXT_SENTINEL', {
          provenance: 'user-edited',
          sources: [{ startMs: 13_013, endMs: 14_014 }]
        })
      ]
    }
  ],
  decisions: [
    item('DECISION_ID_SENTINEL', 'DECISION_TEXT_SENTINEL', {
      sources: [{ startMs: 15_015, endMs: 16_016 }]
    })
  ],
  nextSteps: [
    item('NEXT_STEP_ID_SENTINEL', 'NEXT_STEP_TEXT_SENTINEL', {
      completed: true,
      sources: [{ startMs: 17_017, endMs: 18_018 }]
    })
  ]
}

const snapshot: MeetingExportSnapshot = {
  detail: {
    title: 'MEETING_TITLE_SENTINEL',
    sourceName: 'SOURCE_NAME_SENTINEL',
    date: Date.UTC(2026, 4, 6, 14, 7, 8),
    durationSeconds: 3_661
  },
  notes,
  transcript: [
    {
      id: 'TRANSCRIPT_ID_SENTINEL',
      meetingId: 'TRANSCRIPT_MEETING_ID_SENTINEL',
      speaker: 'speaker-1',
      text: 'TRANSCRIPT_TEXT_SENTINEL',
      startMs: 19_019,
      endMs: 20_020,
      confidence: 0.87654321
    },
    {
      id: 'TRANSCRIPT_TWO_ID_SENTINEL',
      meetingId: 'TRANSCRIPT_MEETING_ID_SENTINEL',
      speaker: 'unregistered-speaker',
      text: 'TRANSCRIPT_TWO_TEXT_SENTINEL',
      startMs: 21_021,
      endMs: 22_022,
      confidence: 0.7654321
    }
  ],
  speakers: {
    'speaker-1': {
      label: 'SPEAKER_LABEL_SENTINEL',
      suggestions: ['SPEAKER_SUGGESTION_ONE_SENTINEL', 'SPEAKER_SUGGESTION_TWO_SENTINEL']
    },
    'speaker-unused': {
      label: 'UNUSED_SPEAKER_LABEL_SENTINEL',
      suggestions: []
    }
  }
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
    const data = compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
    entries.set(name, data)

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
  it('preserves the complete normalized record in the full Markdown variant', () => {
    const markdown = renderMeetingExportMarkdown(snapshot, 'full')
    const record = markdown.match(/(`{3,})json\n([\s\S]*?)\n\1/)

    expect(markdown).toContain('# MEETING\\_TITLE\\_SENTINEL')
    expect(markdown).toContain('OVERVIEW\\_TEXT\\_SENTINEL')
    expect(markdown).toContain('SPEAKER\\_LABEL\\_SENTINEL')
    expect(markdown).toContain('TRANSCRIPT\\_TEXT\\_SENTINEL')
    expect(record).not.toBeNull()
    expect(JSON.parse(record![2])).toEqual(snapshot)
  })

  it('keeps human notes and a readable transcript while omitting internals in concise Markdown', () => {
    const markdown = renderMeetingExportMarkdown(snapshot, 'concise')

    for (const visible of [
      'OVERVIEW\\_TEXT\\_SENTINEL',
      'TAKEAWAY\\_TEXT\\_SENTINEL',
      'SECTION\\_SUMMARY\\_SENTINEL',
      'KEY\\_POINT\\_TEXT\\_SENTINEL',
      'SUPPORTING\\_TEXT\\_SENTINEL',
      'DECISION\\_TEXT\\_SENTINEL',
      'NEXT\\_STEP\\_TEXT\\_SENTINEL',
      'SPEAKER\\_LABEL\\_SENTINEL',
      'TRANSCRIPT\\_TEXT\\_SENTINEL'
    ]) {
      expect(markdown).toContain(visible)
    }
    for (const internal of [
      'NOTES_REVISION_SENTINEL',
      'ATTRIBUTION_REVISION_SENTINEL',
      'LEGACY_SEGMENT_ID_SENTINEL',
      'TRANSCRIPT_ID_SENTINEL',
      'SPEAKER_SUGGESTION_ONE_SENTINEL',
      '0.87654321'
    ]) {
      expect(markdown).not.toContain(internal)
    }
  })

  it('emits semantic, print-ready HTML with a restrictive CSP and a full record', () => {
    const html = renderMeetingExportHtml(snapshot, 'full')

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<main>')
    expect(html).toContain('<header class="masthead">')
    expect(html).toContain('<section aria-labelledby="notes">')
    expect(html).toContain('<article class="utterance"')
    expect(html).toContain('Full-fidelity Record')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('@page { size: Letter portrait; margin: 1in; }')
    expect(html).toContain('--paper: #FAFAF7')
    expect(html).toContain('--sage: #7A9E7E')
    expect(html).toContain('&quot;revision&quot;: &quot;sha256:NOTES_REVISION_SENTINEL&quot;')
    expect(html).toContain('&quot;confidence&quot;: 0.87654321')
    expect(html).toContain('UNUSED_SPEAKER_LABEL_SENTINEL')
  })

  it('escapes untrusted content in Markdown, HTML, and DOCX XML', async () => {
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
      },
      transcript: [
        {
          ...snapshot.transcript[0],
          text: '</w:t><script>transcript & text</script>\n```\n# still data'
        }
      ]
    }

    const markdown = renderMeetingExportMarkdown(unsafe, 'full')
    expect(markdown).not.toContain('<script>')
    expect(markdown).toContain('&lt;script&gt;')
    expect(markdown).toContain('&amp;')
    expect(markdown).toContain('\\*title\\*')
    expect(markdown).toContain('\\[link\\]\\(javascript:alert\\(1\\)\\)')
    const record = markdown.match(/(`{4,})json\n([\s\S]*?)\n\1/)
    expect(record).not.toBeNull()
    expect(JSON.parse(record![2])).toEqual(unsafe)

    const html = renderMeetingExportHtml(unsafe, 'full')
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('</w:t>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;value&quot;')

    const entries = readZipEntries(await renderMeetingExportDocx(unsafe, 'full'))
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

  it('builds a deterministic, valid DOCX with compact-reference styles and real numbering', async () => {
    const [first, second] = await Promise.all([
      renderMeetingExportDocx(snapshot, 'full'),
      renderMeetingExportDocx(snapshot, 'full')
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
    expect(documentXml).toContain('OVERVIEW_TEXT_SENTINEL')
    expect(documentXml).toContain('LEGACY_SEGMENT_ID_SENTINEL')
    expect(documentXml).toContain('TRANSCRIPT_ID_SENTINEL')
    expect(documentXml).toContain('SPEAKER_SUGGESTION_ONE_SENTINEL')
    expect(documentXml).toContain('w:val="Heading1"')
    expect(documentXml).toContain('w:val="MastheadRule"')
    expect(documentXml).toMatch(/<w:pgSz[^>]*w:w="12240"[^>]*w:h="15840"/)
    expect(documentXml).toMatch(
      /<w:pgMar[^>]*w:top="1440"[^>]*w:right="1440"[^>]*w:bottom="1440"[^>]*w:left="1440"[^>]*w:header="708"[^>]*w:footer="708"/
    )

    expect(stylesXml).toContain('w:styleId="MastheadKicker"')
    expect(stylesXml).toContain('w:styleId="TechnicalRecord"')
    expect(stylesXml).toContain('w:color w:val="4A6B4E"')
    expect(stylesXml).toContain('w:spacing w:after="120" w:line="300" w:lineRule="auto"')
    expect(numberingXml).toContain('w:numFmt w:val="bullet"')
    expect(numberingXml).toContain('w:lvlText w:val="•"')
    expect(numberingXml).toContain('w:ind w:left="540" w:hanging="270"')
    expect(footerXml).toContain('PAGE')
    expect(coreXml).toContain('<dc:creator>AutoDoc</dc:creator>')
    expect(coreXml).toContain('2026-05-06T14:07:08.000Z')
  })

  it('keeps the full legacy source union and explicit null revisions', () => {
    const legacyNotes: NormalizedNotes = {
      ...notes,
      source: { format: 'legacy-segments', adapterVersion: 1 },
      sourceTranscriptRevision: null,
      sourceAttributionRevision: null,
      revision: 'legacy-sha256:LEGACY_REVISION_SENTINEL'
    }
    const markdown = renderMeetingExportMarkdown({ ...snapshot, notes: legacyNotes }, 'full')
    const record = markdown.match(/(`{3,})json\n([\s\S]*?)\n\1/)

    expect(JSON.parse(record![2]).notes).toMatchObject({
      source: { format: 'legacy-segments', adapterVersion: 1 },
      sourceTranscriptRevision: null,
      sourceAttributionRevision: null,
      revision: 'legacy-sha256:LEGACY_REVISION_SENTINEL'
    })
  })

  it('handles meetings with no notes or transcript', async () => {
    const empty: MeetingExportSnapshot = { ...snapshot, notes: null, transcript: [], speakers: {} }

    expect(renderMeetingExportMarkdown(empty, 'concise')).toContain('No notes are available')
    expect(renderMeetingExportMarkdown(empty, 'concise')).toContain('No transcript is available')
    expect(renderMeetingExportHtml(empty, 'concise')).toContain('No notes are available')
    expect(
      xml(readZipEntries(await renderMeetingExportDocx(empty, 'concise')), 'word/document.xml')
    ).toContain('No transcript is available')
  })
})

describe('meeting export filenames', () => {
  it('maps formats to native extensions', () => {
    expect(meetingExportExtension('markdown')).toBe('md')
    expect(meetingExportExtension('pdf')).toBe('pdf')
    expect(meetingExportExtension('docx')).toBe('docx')
  })

  it('creates short, filesystem-safe suggested names', () => {
    expect(
      createMeetingExportSuggestedFilename('  Q3: Roadmap / Review?  ', 'markdown', 'concise')
    ).toBe('Q3 Roadmap Review.md')
    expect(createMeetingExportSuggestedFilename('CON', 'docx', 'full')).toBe(
      'Meeting CON - Full.docx'
    )
    expect(createMeetingExportSuggestedFilename('con.txt', 'pdf', 'concise')).toBe(
      'Meeting con.txt.pdf'
    )
    expect(createMeetingExportSuggestedFilename('... ', 'pdf', 'concise')).toBe(
      'Untitled Meeting.pdf'
    )
    expect(
      Buffer.byteLength(
        createMeetingExportSuggestedFilename('📝'.repeat(200), 'docx', 'full'),
        'utf8'
      )
    ).toBeLessThanOrEqual(120)
  })
})
