import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderNoteMarkup } from '../NoteMarkup'

describe('renderNoteMarkup', () => {
  it('turns **pairs** into bold and leaves the rest as text', () => {
    render(<p>{renderNoteMarkup('Chris will **review the PR** after standup.')}</p>)

    expect(screen.getByText('review the PR').tagName).toBe('STRONG')
    expect(screen.queryByText(/\*\*review the PR\*\*/)).not.toBeInTheDocument()
    expect(screen.getByText(/Chris will/)).toBeInTheDocument()
  })
})
