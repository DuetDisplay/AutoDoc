import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { UiLanguagePicker } from './UiLanguagePicker'

describe('app language picker', () => {
  it('opens from the keyboard, navigates options, selects, and restores trigger focus', async () => {
    const change = vi.fn()
    render(<UiLanguagePicker value="en" onChange={change} label="App language" />)
    const trigger = screen.getByRole('button', { name: 'App language' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const english = screen.getByRole('option', { name: 'English' })
    await waitFor(() => expect(english).toHaveFocus())
    fireEvent.keyDown(english, { key: 'End' })
    const korean = screen.getByRole('option', { name: '한국어' })
    await waitFor(() => expect(korean).toHaveFocus())
    fireEvent.keyDown(korean, { key: 'Enter' })
    expect(change).toHaveBeenCalledWith('ko')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('dismisses with Escape without changing the language', async () => {
    const change = vi.fn()
    render(<UiLanguagePicker value="de" onChange={change} label="App language" />)
    const trigger = screen.getByRole('button', { name: 'App language' })
    await userEvent.click(trigger)
    const german = screen.getByRole('option', { name: 'Deutsch' })
    await waitFor(() => expect(german).toHaveFocus())
    fireEvent.keyDown(german, { key: 'Escape' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
    expect(change).not.toHaveBeenCalled()
  })

  it('closes when focus leaves the picker', async () => {
    render(
      <>
        <UiLanguagePicker value="en" onChange={vi.fn()} label="App language" />
        <button>Other control</button>
      </>
    )
    await userEvent.click(screen.getByRole('button', { name: 'App language' }))
    screen.getByRole('button', { name: 'Other control' }).focus()
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })
})
