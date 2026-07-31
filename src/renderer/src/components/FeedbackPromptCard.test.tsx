import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FeedbackPromptCard, type FeedbackPromptCardProps } from './FeedbackPromptCard'

function createProps(overrides: Partial<FeedbackPromptCardProps> = {}): FeedbackPromptCardProps {
  return {
    appearance: 'initial',
    pending: false,
    supportResult: null,
    copyStatus: 'idle',
    onShare: vi.fn(),
    onCopy: vi.fn(),
    onLater: vi.fn(),
    onNever: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides
  }
}

describe('FeedbackPromptCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders as a labelled, non-alert section without taking focus', () => {
    const { container } = render(
      <div>
        <button type="button">Existing focus</button>
        <FeedbackPromptCard {...createProps()} />
      </div>
    )
    const existingFocus = screen.getByRole('button', { name: 'Existing focus' })
    existingFocus.focus()

    const region = screen.getByRole('region', {
      name: 'How’s AutoDoc working for you?'
    })
    expect(region).toHaveAccessibleDescription(
      'Tell us what’s working, what’s missing, or what AutoDoc could do better.'
    )
    expect(region).toHaveAttribute('aria-busy', 'false')
    expect(region).toHaveClass('w-full', 'border-sage/25', 'bg-sage-light/60')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(container.querySelector('[autofocus]')).toBeNull()
    expect(existingFocus).toHaveFocus()
  })

  it('shows the exact initial actions', () => {
    render(<FeedbackPromptCard {...createProps({ appearance: 'initial' })} />)

    expect(screen.getByRole('button', { name: 'Share feedback' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Maybe later' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Don’t ask again' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  it('shows the exact reminder actions', () => {
    render(<FeedbackPromptCard {...createProps({ appearance: 'reminder' })} />)

    expect(screen.getByRole('button', { name: 'Share feedback' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Don’t ask again' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Maybe later' })).not.toBeInTheDocument()
  })

  it('delegates the initial actions to their callbacks', async () => {
    const user = userEvent.setup()
    const props = createProps()
    render(<FeedbackPromptCard {...props} />)

    await user.click(screen.getByRole('button', { name: 'Share feedback' }))
    await user.click(screen.getByRole('button', { name: 'Maybe later' }))
    await user.click(screen.getByRole('button', { name: 'Don’t ask again' }))

    expect(props.onShare).toHaveBeenCalledOnce()
    expect(props.onLater).toHaveBeenCalledOnce()
    expect(props.onNever).toHaveBeenCalledOnce()
    expect(props.onDismiss).not.toHaveBeenCalled()
  })

  it('delegates the reminder dismissal to onDismiss', async () => {
    const user = userEvent.setup()
    const props = createProps({ appearance: 'reminder' })
    render(<FeedbackPromptCard {...props} />)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(props.onDismiss).toHaveBeenCalledOnce()
    expect(props.onLater).not.toHaveBeenCalled()
  })

  it('disables actions and exposes a busy state while a request is pending', async () => {
    const user = userEvent.setup()
    const props = createProps({ pending: true })
    render(<FeedbackPromptCard {...props} />)

    expect(screen.getByRole('region', { name: 'How’s AutoDoc working for you?' })).toHaveAttribute(
      'aria-busy',
      'true'
    )

    for (const name of ['Share feedback', 'Maybe later', 'Don’t ask again']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      await user.click(button)
    }

    expect(props.onShare).not.toHaveBeenCalled()
    expect(props.onLater).not.toHaveBeenCalled()
    expect(props.onNever).not.toHaveBeenCalled()
  })

  it('announces when the email draft opens', () => {
    render(
      <FeedbackPromptCard
        {...createProps({
          supportResult: { status: 'opened' }
        })}
      />
    )

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    expect(status).toHaveTextContent('Draft opened in your email app.')
  })

  it('shows the validated address and delegates the copy fallback', async () => {
    const user = userEvent.setup()
    const props = createProps({
      supportResult: { status: 'copy-required', address: 'team@getautodoc.com' }
    })
    render(<FeedbackPromptCard {...props} />)

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Mail app didn’t open.')
    expect(status).toHaveTextContent('team@getautodoc.com')

    await user.click(screen.getByRole('button', { name: 'Copy email address' }))

    expect(props.onCopy).toHaveBeenCalledOnce()
    expect(props.onCopy).toHaveBeenCalledWith('team@getautodoc.com')
  })

  it.each([
    ['copied', 'Email address copied.'],
    ['failed', 'Couldn’t copy. Select the address above.']
  ] as const)('shows the %s copy status', (copyStatus, message) => {
    render(
      <FeedbackPromptCard
        {...createProps({
          supportResult: { status: 'copy-required', address: 'team@getautodoc.com' },
          copyStatus
        })}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent(message)
  })

  it('announces when support email is unavailable', () => {
    render(
      <FeedbackPromptCard
        {...createProps({
          supportResult: { status: 'unavailable' }
        })}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('Email isn’t configured in this build.')
    expect(screen.queryByRole('button', { name: 'Copy email address' })).not.toBeInTheDocument()
  })
})
