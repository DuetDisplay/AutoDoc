import { describe, expect, it } from 'vitest'
import { notesFailureKindFromCode, notesUserCopy } from '../notes-user-copy'
import { UI_LANGUAGE_CODES } from '../ui-language'

describe('notes user copy', () => {
  it('maps internal codes to the locked user-facing titles', () => {
    expect(notesUserCopy(notesFailureKindFromCode('no_notes_detected')).title).toBe(
      'No notes were generated'
    )
    expect(notesFailureKindFromCode('llm-empty-output')).toBe('nothing-found')
    expect(notesUserCopy(notesFailureKindFromCode('llm-empty-output'))).toEqual({
      title: 'No notes were generated',
      body: 'AutoDoc didn’t find anything in the transcript to turn into notes. You can retry, and your transcript is still available.'
    })
    expect(notesUserCopy(notesFailureKindFromCode('ollama-insufficient-memory')).title).toBe(
      'Not enough available memory'
    )
    expect(notesUserCopy(notesFailureKindFromCode('ollama-unavailable')).body).toContain(
      'notes engine wasn’t ready'
    )
    expect(notesUserCopy(notesFailureKindFromCode('ollama-model-setup')).body).toContain(
      'notes engine wasn’t ready'
    )
    expect(notesUserCopy(notesFailureKindFromCode('scan_or_persist')).title).toBe(
      'Your notes are ready in a basic format'
    )
    expect(notesUserCopy(notesFailureKindFromCode('unknown')).body).toContain(
      'problem writing notes'
    )
  })
})

it('localizes every failure kind rather than returning English for a selected locale', () => {
  for (const kind of ['empty', 'memory', 'engine', 'generic', 'layout'] as const) {
    const english = notesUserCopy(kind)
    for (const language of UI_LANGUAGE_CODES.filter((code) => code !== 'en')) {
      const translated = notesUserCopy(kind, language)
      expect(translated.title, `${kind} ${language}`).not.toBe(english.title)
      expect(translated.body, `${kind} ${language}`).not.toBe(english.body)
    }
  }
})
