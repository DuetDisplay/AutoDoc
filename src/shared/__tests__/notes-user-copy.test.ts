import { describe, expect, it } from 'vitest'
import { notesFailureKindFromCode, notesUserCopy } from '../notes-user-copy'

describe('notes user copy', () => {
  it('maps internal codes to the locked user-facing titles', () => {
    expect(notesUserCopy(notesFailureKindFromCode('no_notes_detected')).title).toBe(
      'No notes were generated'
    )
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
      'We couldn’t finish the new notes layout'
    )
    expect(notesUserCopy(notesFailureKindFromCode('unknown')).body).toContain(
      'problem writing notes'
    )
  })
})
