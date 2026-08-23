import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingExportFailureCode, MeetingExportResult } from '../../../shared/types'
import { MeetingExportMenu, type MeetingExportMenuProps } from './MeetingExportMenu'

function createProps(overrides: Partial<MeetingExportMenuProps> = {}): MeetingExportMenuProps {
  return {
    disabled: false,
    onExport: vi.fn(async () => ({ status: 'cancelled' }) as MeetingExportResult),
    ...overrides
  }
}

async function openExportDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Export' }))
  return screen.getByRole('dialog', { name: 'Export meeting' })
}

function deferredResult(): {
  promise: Promise<MeetingExportResult>
  resolve: (result: MeetingExportResult) => void
} {
  let resolve!: (result: MeetingExportResult) => void
  const promise = new Promise<MeetingExportResult>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('MeetingExportMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders an explicit, collapsed Export trigger with accessible popover semantics', () => {
    render(<MeetingExportMenu {...createProps()} />)

    const trigger = screen.getByRole('button', { name: 'Export' })
    expect(trigger).toBeEnabled()
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-busy', 'false')
    expect(trigger).not.toHaveAttribute('aria-controls')
    expect(trigger.querySelector('svg')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('disables the trigger and exposes the supplied reason to assistive technology', async () => {
    const user = userEvent.setup()
    render(
      <MeetingExportMenu
        {...createProps({
          disabled: true,
          disabledReason: 'Export is available when notes are ready.'
        })}
      />
    )

    const trigger = screen.getByRole('button', { name: 'Export' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAccessibleDescription('Export is available when notes are ready.')
    expect(trigger).toHaveAttribute('title', 'Export is available when notes are ready.')
    await user.click(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens a labelled, right-aligned dialog with Full selected and all format choices', async () => {
    const user = userEvent.setup()
    render(<MeetingExportMenu {...createProps()} />)

    const dialog = await openExportDialog(user)
    const trigger = screen.getByRole('button', { name: 'Export' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', dialog.id)
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    expect(dialog).toHaveAccessibleDescription(
      'Choose how much detail to include, then a file format.'
    )
    expect(dialog).toHaveClass('right-0', 'w-72', 'border-border', 'bg-bg-card', 'rounded-xl')

    const full = screen.getByRole('button', { name: 'Full' })
    const concise = screen.getByRole('button', { name: 'Concise' })
    expect(full).toHaveAttribute('aria-pressed', 'true')
    expect(concise).toHaveAttribute('aria-pressed', 'false')
    expect(full).toHaveFocus()
    expect(screen.getByText('Every stored note and transcript detail.')).toBeInTheDocument()

    const formatButtons = screen
      .getAllByRole('button')
      .filter((button) =>
        /^(PDF|Word|Markdown)/.test(button.getAttribute('aria-label') ?? button.textContent ?? '')
      )
    expect(formatButtons).toHaveLength(3)
    expect(formatButtons[0]).toHaveAccessibleName('PDF Best for sharing .pdf')
    expect(formatButtons[1]).toHaveAccessibleName('Word Editable document .docx')
    expect(formatButtons[2]).toHaveAccessibleName('Markdown Plain text .md')
  })

  it('switches to Concise and explains the presentation-only variant', async () => {
    const user = userEvent.setup()
    render(<MeetingExportMenu {...createProps()} />)
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: 'Concise' }))

    expect(screen.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Concise' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('A polished summary for sharing.')).toBeInTheDocument()
    expect(screen.queryByText('Every stored note and transcript detail.')).not.toBeInTheDocument()
  })

  it('dispatches PDF with the Full default', async () => {
    const user = userEvent.setup()
    const props = createProps()
    render(<MeetingExportMenu {...props} />)
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: /^PDF/ }))

    await waitFor(() => expect(props.onExport).toHaveBeenCalledWith('pdf', 'full'))
  })

  it.each([
    ['Word', 'docx'],
    ['Markdown', 'markdown'],
    ['PDF', 'pdf']
  ] as const)('dispatches %s with the Concise variant', async (label, format) => {
    const user = userEvent.setup()
    const props = createProps()
    render(<MeetingExportMenu {...props} />)
    await openExportDialog(user)
    await user.click(screen.getByRole('button', { name: 'Concise' }))

    await user.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }))

    await waitFor(() => expect(props.onExport).toHaveBeenCalledWith(format, 'concise'))
  })

  it('closes on Escape and restores focus to the Export trigger', async () => {
    const user = userEvent.setup()
    render(<MeetingExportMenu {...createProps()} />)
    await openExportDialog(user)
    expect(screen.getByRole('button', { name: 'Full' })).toHaveFocus()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toHaveFocus())
  })

  it('closes on an outside click without overriding the newly focused control', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <MeetingExportMenu {...createProps()} />
        <button type="button">Outside</button>
      </div>
    )
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: 'Outside' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus()
  })

  it('resets the safer Full variant whenever the popover is reopened', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <MeetingExportMenu {...createProps()} />
        <button type="button">Outside</button>
      </div>
    )
    await openExportDialog(user)
    await user.click(screen.getByRole('button', { name: 'Concise' }))
    await user.click(screen.getByRole('button', { name: 'Outside' }))

    await user.click(screen.getByRole('button', { name: 'Export' }))

    expect(screen.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Every stored note and transcript detail.')).toBeInTheDocument()
  })

  it('locks the trigger and reports busy while export is pending, then treats cancel silently', async () => {
    const user = userEvent.setup()
    const deferred = deferredResult()
    const onExport = vi.fn(() => deferred.promise)
    render(<MeetingExportMenu {...createProps({ onExport })} />)
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: /^PDF/ }))

    const busyTrigger = screen.getByRole('button', { name: 'Exporting…' })
    expect(busyTrigger).toBeDisabled()
    expect(busyTrigger).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(busyTrigger)
    expect(onExport).toHaveBeenCalledOnce()

    await act(async () => deferred.resolve({ status: 'cancelled' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows and politely announces temporary success', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    const user = userEvent.setup()
    const props = createProps({
      onExport: vi.fn(async () => ({ status: 'saved' }))
    })
    render(<MeetingExportMenu {...props} />)
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: /^PDF/ }))
    await act(async () => Promise.resolve())

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    expect(status).toHaveTextContent('Exported')
    expect(screen.getByRole('button', { name: 'Exported' })).toHaveClass(
      'bg-sage-light',
      'text-sage-dark'
    )

    const successTimerIndex = timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2_400)
    expect(successTimerIndex).toBeGreaterThanOrEqual(0)
    const successCallback = timeoutSpy.mock.calls[successTimerIndex][0] as () => void
    const successTimerId = timeoutSpy.mock.results[successTimerIndex].value as number
    window.clearTimeout(successTimerId)
    act(successCallback)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
    timeoutSpy.mockRestore()
  })

  it('shows the exact actionable low-disk error and allows it to be dismissed', async () => {
    const user = userEvent.setup()
    const props = createProps({
      onExport: vi.fn(async () => ({ status: 'failed', code: 'disk-full' }))
    })
    render(<MeetingExportMenu {...props} />)
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: /^PDF/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Not enough disk space to export. Choose another location or free up space.'
    )
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Dismiss export error' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['nothing-to-export', 'There’s nothing ready to export for this meeting.'],
    [
      'permission-denied',
      'AutoDoc couldn’t save to that location. Choose another location and try again.'
    ],
    ['invalid-request', 'AutoDoc couldn’t export this meeting. Try again.'],
    ['render-failed', 'AutoDoc couldn’t export this meeting. Try again.'],
    ['write-failed', 'AutoDoc couldn’t export this meeting. Try again.']
  ] as const)(
    'maps %s to clear failure copy',
    async (code: MeetingExportFailureCode, expectedMessage: string) => {
      const user = userEvent.setup()
      render(
        <MeetingExportMenu
          {...createProps({
            onExport: vi.fn(async () => ({ status: 'failed', code }))
          })}
        />
      )
      await openExportDialog(user)

      await user.click(screen.getByRole('button', { name: /^PDF/ }))

      expect(await screen.findByRole('alert')).toHaveTextContent(expectedMessage)
    }
  )

  it('recovers from an unexpected rejected export request', async () => {
    const user = userEvent.setup()
    render(
      <MeetingExportMenu
        {...createProps({
          onExport: vi.fn(async () => {
            throw new Error('IPC unavailable')
          })
        })}
      />
    )
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: /^PDF/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'AutoDoc couldn’t export this meeting. Try again.'
    )
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('closes the popover if export becomes unavailable', async () => {
    const user = userEvent.setup()
    const props = createProps()
    const { rerender } = render(<MeetingExportMenu {...props} />)
    await openExportDialog(user)

    rerender(
      <MeetingExportMenu
        {...props}
        disabled
        disabledReason="Export is available when notes are ready."
      />
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
  })
})
