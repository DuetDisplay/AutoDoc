import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { meetingLanguageAvailability } from '../../../shared/meeting-language'
import { LOCKED_MEETING_LANGUAGES_HEADING, MeetingLanguagePicker } from './MeetingLanguagePicker'

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

describe('MeetingLanguagePicker on a Mac with the small notes model', () => {
  const availability = meetingLanguageAvailability(true)

  it('lists available languages first and locks the rest under a heading', async () => {
    const user = userEvent.setup()
    render(<MeetingLanguagePicker value="en" onChange={vi.fn()} availability={availability} />)

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(24)
    expect(options.slice(0, 5).map((option) => option.textContent)).toEqual([
      'EnglishDefault · optimized✓',
      'French',
      'German',
      'Italian',
      'Portuguese'
    ])
    expect(options.slice(0, 5).every((option) => !option.hasAttribute('aria-disabled'))).toBe(true)
    expect(
      options.slice(5).every((option) => option.getAttribute('aria-disabled') === 'true')
    ).toBe(true)
    expect(screen.getByText(LOCKED_MEETING_LANGUAGES_HEADING)).toBeInTheDocument()
  })

  it('does not select a locked language', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MeetingLanguagePicker value="en" onChange={onChange} availability={availability} />)

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))
    await user.click(screen.getByRole('option', { name: 'Japanese' }))
    expect(onChange).not.toHaveBeenCalled()

    await user.click(screen.getByRole('option', { name: 'German' }))
    expect(onChange).toHaveBeenCalledWith('de')
  })
})
