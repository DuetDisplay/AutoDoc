import { describe, expect, it, vi } from 'vitest'
import type { Transcript } from '../../../shared/types'
import { OllamaProvider } from '../llm'
import {
  noteRecordNeedsReview,
  noteTextLooksCoherent,
  noteTextLooksCorrupted
} from '../notes-coherence'
import { contentTokens } from '../notes-evidence-validate'
import { runWithMeetingLanguage } from '../notes-language'
import { overviewConflictsWithCatalog } from '../notes-overview'
import { sanitizeWriterRecords, type WriterGroundingLine } from '../notes-writer-grounding'
import { hasUsableTranscriptContent } from '../transcript-guardrails'

vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))
vi.mock('../sentry-reporter', () => ({ captureMessage: vi.fn() }))

const cases = [
  {
    language: 'de',
    lines: [
      'Wir verschieben den Start des Abrechnungsportals auf Freitag.',
      'Dana schickt das Preis-Update mit 12 Prozent bis Montag.'
    ],
    decision: 'Der Start des Abrechnungsportals wird auf Freitag verschoben.',
    action: 'Dana schickt das Preis-Update mit 12 Prozent.',
    invented: 'Dana schickt das Preis-Update mit 15 Prozent.'
  },
  {
    language: 'bg',
    lines: [
      'Отлагаме пускането на портала за плащания за петък.',
      'Дана ще изпрати актуализацията на цените с 12 процента до понеделник.'
    ],
    decision: 'Пускането на портала за плащания се отлага за петък.',
    action: 'Дана ще изпрати актуализацията на цените с 12 процента.',
    invented: 'Дана ще изпрати актуализацията на цените с 15 процента.'
  },
  {
    language: 'uk',
    lines: [
      'Ми переносимо запуск платіжного порталу на пʼятницю.',
      'Дана надішле оновлення цін на 12 відсотків.'
    ],
    decision: 'Запуск платіжного порталу переноситься на пʼятницю.',
    action: 'Дана надішле оновлення цін на 12 відсотків.',
    invented: 'Дана надішле оновлення цін на 15 відсотків.'
  },
  {
    language: 'ja',
    lines: [
      '請求ポータルの公開を金曜日に延期します。',
      'ダナさんは月曜日までに12%の価格改定を送ります。'
    ],
    decision: '請求ポータルの公開は金曜日に延期されます。',
    action: 'ダナさんは月曜日までに12%の価格改定を送ります。',
    invented: 'ダナさんは月曜日までに15%の価格改定を送ります。'
  },
  {
    language: 'zh-Hans',
    lines: ['我们把计费门户的上线推迟到周五。', '达纳会在周一之前发送12%的价格更新。'],
    decision: '计费门户的上线推迟到周五。',
    action: '达纳会在周一之前发送12%的价格更新。',
    invented: '达纳会在周一之前发送15%的价格更新。'
  },
  {
    language: 'ko',
    lines: [
      '결제 포털 출시를 금요일로 연기합니다.',
      '다나가 월요일까지 12% 가격 업데이트를 보냅니다.'
    ],
    decision: '결제 포털 출시가 금요일로 연기됩니다.',
    action: '다나가 월요일까지 12% 가격 업데이트를 보냅니다.',
    invented: '다나가 월요일까지 15% 가격 업데이트를 보냅니다.'
  }
] as const

function transcriptLines(lines: readonly string[]): WriterGroundingLine[] {
  return lines.map((text, index) => ({ startMs: index * 20_000, text }))
}

describe.each(cases)(
  '$language writer grounding',
  ({ language, lines, decision, action, invented }) => {
    const transcript = transcriptLines(lines)

    it.each(['verbatim', 'paraphrase'] as const)(
      'keeps grounded records, their category, and their timestamps (%s)',
      (mode) => {
        const records = runWithMeetingLanguage(language, () => [
          ...sanitizeWriterRecords(
            'decisions',
            { title: decision, content: decision },
            { startMs: 0, endMs: 0 },
            transcript,
            mode
          ),
          ...sanitizeWriterRecords(
            'action_items',
            { title: action, content: action },
            { startMs: 20_000, endMs: 20_000 },
            transcript,
            mode
          )
        ])

        expect(records).toEqual([
          expect.objectContaining({
            category: 'decisions',
            content: decision,
            sourceStartMs: 0,
            sourceEndMs: 0
          }),
          expect.objectContaining({
            category: 'action_items',
            content: action,
            sourceStartMs: 20_000,
            sourceEndMs: 20_000
          })
        ])
      }
    )

    it('rejects an invented number and a citation to unrelated speech', () => {
      runWithMeetingLanguage(language, () => {
        expect(
          sanitizeWriterRecords(
            'action_items',
            { title: invented, content: invented },
            { startMs: 20_000, endMs: 20_000 },
            transcript
          )
        ).toEqual([])
        expect(
          sanitizeWriterRecords(
            'decisions',
            { title: decision, content: decision },
            { startMs: 20_000, endMs: 20_000 },
            transcriptLines(['Hallo zusammen, können alle mich hören?', lines[1]])
          )
        ).toEqual([])
      })
    })

    it('counts the transcript as usable content', () => {
      const rows = lines.map((text, index) => ({
        meetingId: 'm',
        speaker: 'me',
        text,
        startMs: index * 20_000,
        endMs: index * 20_000 + 5_000
      })) as Transcript[]
      expect(runWithMeetingLanguage(language, () => hasUsableTranscriptContent(rows))).toBe(true)
    })

    it('keeps content tokens for evidence validation', () => {
      expect(
        runWithMeetingLanguage(language, () => contentTokens(decision)).length
      ).toBeGreaterThan(2)
    })
  }
)

describe('English-only text heuristics stay English-only', () => {
  it('treats accented words as text, not mojibake, outside English meetings', () => {
    expect(
      runWithMeetingLanguage('de', () => noteTextLooksCorrupted('Die Käserei liefert am Freitag.'))
    ).toBe(false)
    // Unchanged English behavior.
    expect(noteTextLooksCorrupted('Die Käserei liefert am Freitag.')).toBe(true)
    expect(runWithMeetingLanguage('de', () => noteTextLooksCorrupted('Die K�serei liefert.'))).toBe(
      true
    )
  })

  it('does not read German "Er" as an English disfluency', () => {
    expect(
      runWithMeetingLanguage('de', () => noteRecordNeedsReview('Er schickt das Update am Freitag.'))
    ).toBe(false)
    expect(noteRecordNeedsReview('Er schickt das Update am Freitag.')).toBe(true)
  })

  it('skips English modality guardrails but keeps invented-quantity checks in overviews', () => {
    const catalog = '- Er will das Portal am Freitag starten.\n- Das Budget liegt bei 12 Prozent.'
    runWithMeetingLanguage('de', () => {
      expect(
        overviewConflictsWithCatalog('Er will das Portal am Freitag starten.', catalog)
      ).toBeNull()
      expect(overviewConflictsWithCatalog('Das Budget liegt bei 40 Prozent.', catalog)).toBe(
        'invented-quantity'
      )
    })
  })

  it('keeps distinct Cyrillic writer topics distinct', () => {
    const provider = new OllamaProvider('http://localhost:11434', 'test-model') as unknown as {
      normalizeTopicText(text: string): string
    }
    runWithMeetingLanguage('bg', () => {
      expect(provider.normalizeTopicText('Портал за плащания')).not.toBe('')
      expect(provider.normalizeTopicText('Портал за плащания')).not.toBe(
        provider.normalizeTopicText('Ценообразуване')
      )
    })
    runWithMeetingLanguage('uk', () => {
      expect(provider.normalizeTopicText('Платіжний портал')).toBe('платіжний портал')
    })
  })
})

describe('Japanese, Chinese, and Korean notes', () => {
  it.each([
    ['ja', '請求ポータルの公開を金曜日に延期します。'],
    ['zh-Hans', '我们把计费门户的上线推迟到周五。']
  ])('counts words in an unspaced %s note', (language, note) => {
    expect(runWithMeetingLanguage(language, () => noteTextLooksCoherent(note))).toBe(true)
    // English counting sees one "word" and would reject every such note.
    expect(noteTextLooksCoherent(note)).toBe(false)
  })

  it('keeps two-character topic words', () => {
    const provider = new OllamaProvider('http://localhost:11434', 'test-model') as unknown as {
      normalizeTopicText(text: string): string
    }
    runWithMeetingLanguage('ja', () => {
      expect(provider.normalizeTopicText('価格改定')).not.toBe('')
      expect(provider.normalizeTopicText('価格改定')).not.toBe(
        provider.normalizeTopicText('請求ポータル')
      )
    })
  })

  it('splits CJK transcripts into smaller writer chunks than the same length of English', () => {
    const provider = new OllamaProvider('http://localhost:11434', 'test-model') as unknown as {
      chunkTranscript(text: string): string[]
    }
    const lines = Array.from(
      { length: 200 },
      (_, index) =>
        `[${String(index).padStart(2, '0')}:00] [me] 請求ポータルの公開を金曜日に延期します。`
    ).join('\n')

    const english = provider.chunkTranscript(lines)
    const japanese = runWithMeetingLanguage('ja', () => provider.chunkTranscript(lines))
    const german = runWithMeetingLanguage('de', () => provider.chunkTranscript(lines))

    expect(german).toEqual(english)
    expect(japanese.length).toBeGreaterThanOrEqual(english.length * 2)
    for (const chunk of japanese) expect(chunk.length).toBeLessThanOrEqual(1_500)
  })
})
