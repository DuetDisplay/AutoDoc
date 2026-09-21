import { describe, expect, it } from 'vitest'
import { notesFailureKindFromCode, notesUserCopy } from '../notes-user-copy'

describe('notes user copy', () => {
  it('maps internal codes to the locked user-facing titles', () => {
    expect(notesUserCopy(notesFailureKindFromCode('no_notes_detected')).title).toBe(
      'No notes were generated'
    )
    expect(notesFailureKindFromCode('llm-empty-output')).toBe('generic')
    expect(notesUserCopy(notesFailureKindFromCode('llm-empty-output'))).toEqual({
      title: 'Notes couldn’t finish',
      body: 'AutoDoc hit a problem writing notes this time. Your transcript is still available.'
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
