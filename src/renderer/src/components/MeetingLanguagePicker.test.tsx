import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { meetingLanguageAvailability } from '../../../shared/meeting-language'
import { formatMeetingLanguageFirstUseDownload } from '../services/format-bytes'
import {
  meetingLanguageSelectableNote,
  SLOWER_MEETING_LANGUAGE_NOTE
} from '../services/meeting-language-copy'
import { LOCKED_MEETING_LANGUAGES_HEADING, MeetingLanguagePicker } from './MeetingLanguagePicker'

describe('MeetingLanguagePicker', () => {
  it('shows all supported languages and exposes English as the optimized default', async () => {
    const user = userEvent.setup()
    render(<MeetingLanguagePicker value="en" onChange={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: 'Meeting language: English' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)

    expect(screen.getByRole('listbox', { name: 'Meeting language options' })).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(27)
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
    expect(options).toHaveLength(27)
    expect(options[0]!.textContent).toBe('EnglishDefault · optimized✓')
    expect(options[0]).not.toHaveAttribute('aria-disabled')
    expect(
      options.slice(1).every((option) => option.getAttribute('aria-disabled') === 'true')
    ).toBe(true)
    expect(screen.getByText(LOCKED_MEETING_LANGUAGES_HEADING)).toBeInTheDocument()
  })

  it('does not select a locked language', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MeetingLanguagePicker value="en" onChange={onChange} availability={availability} />)

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))
    await user.click(screen.getByRole('option', { name: 'Japanese' }))
    await user.click(screen.getByRole('option', { name: 'German' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('MeetingLanguagePicker Windows engine availability', () => {
  it('keeps a slower language selectable and shows the note', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <MeetingLanguagePicker
        value="en"
        onChange={onChange}
        availability={{
          ...meetingLanguageAvailability(false),
          languageStates: {
            de: { availability: 'slower', reason: null, firstUseDownloadBytes: 0 }
          }
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))
    const german = screen.getByRole('option', { name: new RegExp(`German\\s+${SLOWER_MEETING_LANGUAGE_NOTE}`) })
    expect(german).not.toHaveAttribute('aria-disabled')
    await user.click(german)
    expect(onChange).toHaveBeenCalledWith('de')
  })

  it('disables a locked language and shows the returned reason', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const reason = 'Spanish needs a supported graphics card on this PC.'
    render(
      <MeetingLanguagePicker
        value="en"
        onChange={onChange}
        availability={{
          ...meetingLanguageAvailability(false),
          languageStates: {
            es: { availability: 'locked', reason, firstUseDownloadBytes: 0 }
          }
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))
    const spanish = screen.getByRole('option', { name: new RegExp(`Spanish\\s+${reason}`) })
    expect(spanish).toHaveAttribute('aria-disabled', 'true')
    await user.click(spanish)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByText(LOCKED_MEETING_LANGUAGES_HEADING)).not.toBeInTheDocument()
  })

  it('leaves an available language unmarked', async () => {
    const user = userEvent.setup()
    render(
      <MeetingLanguagePicker
        value="en"
        onChange={vi.fn()}
        availability={{
          ...meetingLanguageAvailability(false),
          languageStates: {
            fr: { availability: 'available', reason: null, firstUseDownloadBytes: 0 }
          }
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))
    expect(screen.getByRole('option', { name: 'French' })).not.toHaveAttribute('aria-disabled')
    expect(screen.queryByText(SLOWER_MEETING_LANGUAGE_NOTE)).not.toBeInTheDocument()
  })

  it('shows the first-use size on a selectable row before the language is selected', async () => {
    const user = userEvent.setup()
    const sizeNote = formatMeetingLanguageFirstUseDownload(5_583_216_230)
    render(
      <MeetingLanguagePicker
        value="en"
        onChange={vi.fn()}
        availability={{
          ...meetingLanguageAvailability(false),
          languageStates: {
            de: {
              availability: 'available',
              reason: null,
              firstUseDownloadBytes: 5_583_216_230
            }
          }
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))
    expect(screen.getByRole('option', { name: `German ${sizeNote}` })).toBeInTheDocument()
  })

  it('combines the slower note with the first-use size', async () => {
    const user = userEvent.setup()
    const sizeNote = formatMeetingLanguageFirstUseDownload(1_610_612_736)
    const combined = meetingLanguageSelectableNote({
      availability: 'slower',
      reason: null,
      firstUseDownloadBytes: 1_610_612_736
    })
    expect(combined).toBe(`${SLOWER_MEETING_LANGUAGE_NOTE} · ${sizeNote}`)

    render(
      <MeetingLanguagePicker
        value="en"
        onChange={vi.fn()}
        availability={{
          ...meetingLanguageAvailability(false),
          languageStates: {
            de: {
              availability: 'slower',
              reason: null,
              firstUseDownloadBytes: 1_610_612_736
            }
          }
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))
    expect(screen.getByRole('option', { name: `German ${combined}` })).not.toHaveAttribute(
      'aria-disabled'
    )
  })

  it('does not show a first-use size on a locked row', async () => {
    const user = userEvent.setup()
    const reason = 'Spanish needs a supported graphics card on this PC.'
    render(
      <MeetingLanguagePicker
        value="en"
        onChange={vi.fn()}
        availability={{
          ...meetingLanguageAvailability(false),
          languageStates: {
            es: {
              availability: 'locked',
              reason,
              firstUseDownloadBytes: 5_583_216_230
            }
          }
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))
    expect(screen.getByRole('option', { name: `Spanish ${reason}` })).toBeInTheDocument()
    expect(screen.queryByText(/download on first use/i)).not.toBeInTheDocument()
  })
})
