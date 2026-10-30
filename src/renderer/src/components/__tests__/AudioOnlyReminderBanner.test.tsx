import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AudioOnlyReminderBanner } from '../AudioOnlyReminderBanner'

describe('AudioOnlyReminderBanner', () => {
  it('renders nothing when hidden', () => {
    const { container } = render(
      <AudioOnlyReminderBanner visible={false} minutes={5} onStop={vi.fn()} onKeep={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the message and wires both buttons', async () => {
    const onStop = vi.fn()
    const onKeep = vi.fn()
    render(<AudioOnlyReminderBanner visible minutes={5} onStop={onStop} onKeep={onKeep} />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Video stopped 5 minutes ago. AutoDoc is still recording audio.'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Keep recording' }))
    expect(onKeep).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
