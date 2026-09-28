import { describe, expect, it, vi } from 'vitest'
import type { Transcript } from '../../../shared/types'
import { OllamaProvider } from '../llm'
import { noteRecordNeedsReview, noteTextLooksCorrupted } from '../notes-coherence'
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
    language: 'el',
    lines: [
      'Αποφασίσαμε να μεταφέρουμε την κυκλοφορία της πύλης χρεώσεων την Παρασκευή.',
      'Η Ντάνα θα στείλει την ενημέρωση τιμών με 12 τοις εκατό.'
    ],
    decision: 'Η κυκλοφορία της πύλης χρεώσεων μεταφέρεται την Παρασκευή.',
    action: 'Η Ντάνα θα στείλει την ενημέρωση τιμών με 12 τοις εκατό.',
    invented: 'Η Ντάνα θα στείλει την ενημέρωση τιμών με 15 τοις εκατό.'
  },
  {
    language: 'ru',
    lines: [
      'Мы переносим запуск платёжного портала на пятницу.',
      'Дана отправит обновление цен на 12 процентов.'
    ],
    decision: 'Запуск платёжного портала переносится на пятницу.',
    action: 'Дана отправит обновление цен на 12 процентов.',
    invented: 'Дана отправит обновление цен на 15 процентов.'
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

  it('keeps distinct Greek and Cyrillic writer topics distinct', () => {
    const provider = new OllamaProvider('http://localhost:11434', 'test-model') as unknown as {
      normalizeTopicText(text: string): string
    }
    runWithMeetingLanguage('el', () => {
      expect(provider.normalizeTopicText('Πύλη χρεώσεων')).not.toBe('')
      expect(provider.normalizeTopicText('Πύλη χρεώσεων')).not.toBe(
        provider.normalizeTopicText('Τιμολόγηση')
      )
    })
    runWithMeetingLanguage('ru', () => {
      expect(provider.normalizeTopicText('Платёжный портал')).toBe('платёжный портал')
    })
  })
})
