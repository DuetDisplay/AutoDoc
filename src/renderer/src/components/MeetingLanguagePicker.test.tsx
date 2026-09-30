import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MeetingLanguagePicker } from './MeetingLanguagePicker'

describe('MeetingLanguagePicker', () => {
  it('shows all supported languages and exposes English as the optimized default', async () => {
    const user = userEvent.setup()
    render(<MeetingLanguagePicker value="en" onChange={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: 'Meeting language: English' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)

    expect(screen.getByRole('listbox', { name: 'Meeting language options' })).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(24)
    expect(screen.getByRole('option', { name: /English Default · optimized/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('supports arrow-key selection and returns focus to the trigger', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MeetingLanguagePicker value="en" onChange={onChange} />)

    const trigger = screen.getByRole('button', { name: 'Meeting language: English' })
    trigger.focus()
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenCalledWith('bg')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes without changing the selection when Escape is pressed', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MeetingLanguagePicker value="fr" onChange={onChange} />)

    const trigger = screen.getByRole('button', { name: 'Meeting language: French' })
    trigger.focus()
    await user.keyboard('{ArrowDown}{Escape}')

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
