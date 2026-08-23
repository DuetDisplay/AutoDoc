import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MeetingCopyNotesResult,
  MeetingExportFailureCode,
  MeetingExportResult
} from '../../../shared/types'
import { MeetingExportMenu, type MeetingExportMenuProps } from './MeetingExportMenu'

function createProps(overrides: Partial<MeetingExportMenuProps> = {}): MeetingExportMenuProps {
  return {
    disabled: false,
    onCopyNotes: vi.fn(async () => ({ status: 'copied' }) as MeetingCopyNotesResult),
    onExport: vi.fn(async () => ({ status: 'cancelled' }) as MeetingExportResult),
    ...overrides
  }
}

async function openExportDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Export' }))
  return screen.getByRole('dialog', { name: 'Export notes' })
}

function deferred<T>(): { promise: Promise<T>; resolve: (result: T) => void } {
  let resolve!: (result: T) => void
  const promise = new Promise<T>((next) => {
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

  it('renders quiet Copy notes and collapsed Export controls', () => {
    render(<MeetingExportMenu {...createProps()} />)

    const copy = screen.getByRole('button', { name: 'Copy notes' })
    const exportTrigger = screen.getByRole('button', { name: 'Export' })
    expect(copy).toBeEnabled()
    expect(copy).toHaveAttribute('aria-busy', 'false')
    expect(exportTrigger).toBeEnabled()
    expect(exportTrigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(exportTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(exportTrigger).toHaveAttribute('aria-busy', 'false')
    expect(exportTrigger).not.toHaveAttribute('aria-controls')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('disables both controls and exposes the supplied reason', async () => {
    const user = userEvent.setup()
    render(
      <MeetingExportMenu
        {...createProps({
          disabled: true,
          disabledReason: 'Notes are available when generation finishes.'
        })}
      />
    )

    for (const label of ['Copy notes', 'Export']) {
      const control = screen.getByRole('button', { name: label })
      expect(control).toBeDisabled()
      expect(control).toHaveAccessibleDescription('Notes are available when generation finishes.')
      expect(control).toHaveAttribute('title', 'Notes are available when generation finishes.')
      await user.click(control)
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('copies notes in one click without opening the export dialog', async () => {
    const props = createProps()
    const user = userEvent.setup()
    render(<MeetingExportMenu {...props} />)

    await user.click(screen.getByRole('button', { name: 'Copy notes' }))

    await waitFor(() => expect(props.onCopyNotes).toHaveBeenCalledOnce())
    expect(props.onExport).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('locks both controls while copy is pending, then politely reports Copied', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    const pending = deferred<MeetingCopyNotesResult>()
    const onCopyNotes = vi.fn(() => pending.promise)
    const user = userEvent.setup()
    render(<MeetingExportMenu {...createProps({ onCopyNotes })} />)

    await user.click(screen.getByRole('button', { name: 'Copy notes' }))

    const busyCopy = screen.getByRole('button', { name: 'Copying…' })
    expect(busyCopy).toBeDisabled()
    expect(busyCopy).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    await user.click(busyCopy)
    expect(onCopyNotes).toHaveBeenCalledOnce()

    await act(async () => pending.resolve({ status: 'copied' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    expect(status).toHaveTextContent('Copied')
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveClass(
      'bg-sage-light',
      'text-sage-dark'
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toHaveFocus())

    const successTimerIndex = timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2_400)
    expect(successTimerIndex).toBeGreaterThanOrEqual(0)
    const successCallback = timeoutSpy.mock.calls[successTimerIndex][0] as () => void
    const successTimerId = timeoutSpy.mock.results[successTimerIndex].value as number
    window.clearTimeout(successTimerId)
    act(successCallback)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy notes' })).toBeInTheDocument()
    timeoutSpy.mockRestore()
  })

  it('keeps the actionable nothing-to-copy error visible until dismissed', async () => {
    const user = userEvent.setup()
    render(
      <MeetingExportMenu
        {...createProps({
          onCopyNotes: vi.fn(async () => ({ status: 'failed', code: 'nothing-to-copy' }))
        })}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Copy notes' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('There aren’t any notes to copy yet.')
    expect(screen.getByRole('button', { name: 'Copy notes' })).toBeEnabled()
    await act(async () => Promise.resolve())
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Dismiss copy error' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['invalid-request', 'copy-failed'] as const)(
    'maps copy failure %s to clear retry copy',
    async (code) => {
      const user = userEvent.setup()
      render(
        <MeetingExportMenu
          {...createProps({
            onCopyNotes: vi.fn(async () => ({ status: 'failed', code }))
          })}
        />
      )

      await user.click(screen.getByRole('button', { name: 'Copy notes' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t copy notes. Try again.')
    }
  )

  it('recovers from an unexpected rejected copy request', async () => {
    const user = userEvent.setup()
    render(
      <MeetingExportMenu
        {...createProps({
          onCopyNotes: vi.fn(async () => {
            throw new Error('IPC unavailable')
          })
        })}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Copy notes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t copy notes. Try again.')
  })

  it('opens Export notes with only the three file formats', async () => {
    const user = userEvent.setup()
    render(<MeetingExportMenu {...createProps()} />)

    const dialog = await openExportDialog(user)
    const exportTrigger = screen.getByRole('button', { name: 'Export' })
    expect(exportTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(exportTrigger).toHaveAttribute('aria-controls', dialog.id)
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    expect(dialog).toHaveAccessibleDescription('Choose a file format.')
    expect(dialog).toHaveClass('right-0', 'w-64', 'border-border', 'bg-bg-card', 'rounded-xl')
    expect(screen.queryByRole('button', { name: 'Full' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Concise' })).not.toBeInTheDocument()
    expect(screen.queryByText(/stored note|polished summary/i)).not.toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'PDF Best for sharing .pdf' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Word Editable document .docx' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Markdown Plain text .md' })).toBeInTheDocument()
  })

  it.each([
    ['PDF', 'pdf'],
    ['Word', 'docx'],
    ['Markdown', 'markdown']
  ] as const)('dispatches the %s format without a presentation variant', async (label, format) => {
    const props = createProps()
    const user = userEvent.setup()
    render(<MeetingExportMenu {...props} />)
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }))

    await waitFor(() => expect(props.onExport).toHaveBeenCalledWith(format))
    expect(props.onExport).toHaveBeenCalledOnce()
  })

  it('closes on Escape and restores focus to Export', async () => {
    const user = userEvent.setup()
    render(<MeetingExportMenu {...createProps()} />)
    await openExportDialog(user)

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

  it('locks both controls while export is pending and treats cancel silently', async () => {
    const pending = deferred<MeetingExportResult>()
    const onExport = vi.fn(() => pending.promise)
    const user = userEvent.setup()
    render(<MeetingExportMenu {...createProps({ onExport })} />)
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: /^PDF/ }))

    const busyExport = screen.getByRole('button', { name: 'Exporting…' })
    expect(busyExport).toBeDisabled()
    expect(busyExport).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Copy notes' })).toBeDisabled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(busyExport)
    expect(onExport).toHaveBeenCalledOnce()

    await act(async () => pending.resolve({ status: 'cancelled' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('briefly turns Export into a politely announced success', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    const user = userEvent.setup()
    render(
      <MeetingExportMenu {...createProps({ onExport: vi.fn(async () => ({ status: 'saved' })) })} />
    )
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: /^PDF/ }))

    const status = await screen.findByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
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

  it('shows the exact low-disk error until it is dismissed', async () => {
    const user = userEvent.setup()
    render(
      <MeetingExportMenu
        {...createProps({
          onExport: vi.fn(async () => ({ status: 'failed', code: 'disk-full' }))
        })}
      />
    )
    await openExportDialog(user)

    await user.click(screen.getByRole('button', { name: /^PDF/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Not enough disk space to export. Choose another location or free up space.'
    )
    await act(async () => Promise.resolve())
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Dismiss export error' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['nothing-to-export', 'There aren’t any notes to export yet.'],
    [
      'permission-denied',
      'AutoDoc couldn’t save the notes there. Choose another location and try again.'
    ],
    ['invalid-request', 'Couldn’t export notes. Try again.'],
    ['render-failed', 'Couldn’t export notes. Try again.'],
    ['write-failed', 'Couldn’t export notes. Try again.']
  ] as const)(
    'maps export failure %s to clear retry copy',
    async (code: MeetingExportFailureCode, expectedMessage: string) => {
      const user = userEvent.setup()
      render(
        <MeetingExportMenu
          {...createProps({ onExport: vi.fn(async () => ({ status: 'failed', code })) })}
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

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t export notes. Try again.')
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('closes the popover if notes actions become unavailable', async () => {
    const user = userEvent.setup()
    const props = createProps()
    const { rerender } = render(<MeetingExportMenu {...props} />)
    await openExportDialog(user)

    rerender(
      <MeetingExportMenu
        {...props}
        disabled
        disabledReason="There aren’t any notes to copy or export."
      />
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy notes' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
  })
})
