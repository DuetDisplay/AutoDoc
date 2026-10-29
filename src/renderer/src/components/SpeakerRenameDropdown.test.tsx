import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SpeakerRenameDropdown } from './SpeakerRenameDropdown'

describe('speaker rename', () => {
  it('keeps the name instruction visible and submits a custom name by keyboard', async () => {
    const user = userEvent.setup(),
      onRename = vi.fn(),
      onClose = vi.fn()
    render(
      <SpeakerRenameDropdown
        anchorRef={{ current: document.body }}
        onRename={onRename}
        onClose={onClose}
      />
    )
    const input = screen.getByRole('textbox', { name: 'Type a custom name...' })
    expect(screen.getByText('Type a custom name...')).toBeVisible()
    expect(input).toHaveFocus()
    await user.type(input, ' Morgan{Enter}')
    expect(onRename).toHaveBeenCalledWith('Morgan')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('returns focus to the opening control on Escape without renaming', async () => {
    const user = userEvent.setup(),
      onRename = vi.fn(),
      onClose = vi.fn()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    try {
      render(
        <SpeakerRenameDropdown
          anchorRef={{ current: opener }}
          onRename={onRename}
          onClose={onClose}
        />
      )
      await user.keyboard('{Escape}')
      expect(onClose).toHaveBeenCalledOnce()
      expect(onRename).not.toHaveBeenCalled()
      expect(opener).toHaveFocus()
    } finally {
      opener.remove()
    }
  })
})
