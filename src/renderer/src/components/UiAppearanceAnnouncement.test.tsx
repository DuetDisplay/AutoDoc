import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { AnnouncementQueue } from './AnnouncementQueue'
import { I18nProvider } from '../services/i18n'
import { ThemeProvider } from '../services/theme'
import { meetingLanguageAvailability } from '../../../shared/meeting-language'

const invoke = vi.fn()
const visibility = vi.fn()
let meetingPending = false
let appearancePending = true
let savedMeetingLanguage = 'en'
let platform = 'darwin'
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  meetingPending = false
  appearancePending = true
  savedMeetingLanguage = 'en'
  platform = 'darwin'
  invoke.mockImplementation(async (channel: string, value?: string) => {
    if (channel === 'prefs:get-meeting-language-announcement-pending') return meetingPending
    if (channel === 'prefs:get-ui-appearance-announcement-pending') return appearancePending
    if (channel === 'prefs:dismiss-ui-appearance-announcement') appearancePending = false
    if (channel === 'prefs:dismiss-meeting-language-announcement') meetingPending = false
    if (channel === 'prefs:confirm-onboarding-language') meetingPending = false
    if (channel === 'prefs:get-ui-language') return 'en'
    if (channel === 'prefs:get-appearance') return 'light'
    if (channel === 'prefs:get-meeting-language') return savedMeetingLanguage
    if (channel === 'prefs:set-meeting-language') savedMeetingLanguage = value!
    if (channel === 'prefs:get-meeting-language-availability')
      return meetingLanguageAvailability(false)
    if (channel === 'app:get-runtime-info') return { platform }
    if (channel === 'whisper:get-meeting-language-states') return {}
    if (channel === 'whisper:get-windows-meeting-language-availability')
      return { availability: 'available', firstUseDownloadBytes: 0 }
  })
  window.electronAPI = { invoke, on: vi.fn(() => () => {}), send: vi.fn() } as any
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})
function CurrentRoute() {
  const location = useLocation()
  return (
    <output>
      {location.pathname}
      {location.search}
    </output>
  )
}
function Popup({ suppressed = false }: { suppressed?: boolean }) {
  return (
    <MemoryRouter>
      <ThemeProvider>
        <I18nProvider>
          <AnnouncementQueue suppressed={suppressed} onVisibilityChange={visibility} />
        </I18nProvider>
      </ThemeProvider>
      <CurrentRoute />
    </MemoryRouter>
  )
}
it('applies the shared language and theme preferences live and permanently dismisses', async () => {
  render(<Popup />)
  await screen.findByRole('dialog')
  expect(screen.getByRole('heading', { name: 'New' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Meeting language' })).not.toBeInTheDocument()
  const choices = within(screen.getByRole('radiogroup', { name: 'Appearance' }))
  expect(choices.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
  await act(async () => fireEvent.click(choices.getByRole('radio', { name: 'Dark' })))
  expect(invoke).toHaveBeenCalledWith('prefs:set-appearance', 'dark')
  expect(choices.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
  expect(choices.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'App language' })))
  await act(async () => fireEvent.click(screen.getByRole('option', { name: 'Deutsch' })))
  expect(invoke).toHaveBeenCalledWith('prefs:set-ui-language', 'de')
  expect(screen.getByRole('heading', { name: 'Neu' })).toBeInTheDocument()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Fertig' })))
  expect(invoke).toHaveBeenCalledWith('prefs:dismiss-ui-appearance-announcement')
  expect(appearancePending).toBe(false)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it.each([true, false])(
  'combines meeting-language setup with app language and appearance (appearance pending: %s)',
  async (pending) => {
    meetingPending = true
    appearancePending = pending
    render(<Popup />)
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Transcripts and notes now support 27 languages!'
    )
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'App language' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Done' })))
    expect(invoke).toHaveBeenCalledWith('prefs:dismiss-meeting-language-announcement')
    expect(invoke).toHaveBeenCalledWith('prefs:dismiss-ui-appearance-announcement')
    expect(meetingPending).toBe(false)
    expect(appearancePending).toBe(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  }
)
it('never shows for a non-pending profile', async () => {
  appearancePending = false
  render(<Popup />)
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('prefs:get-ui-appearance-announcement-pending')
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('waits while a recording or another dialog is active', async () => {
  const view = render(<Popup suppressed />)
  await waitFor(() => expect(invoke).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  view.rerender(<Popup />)
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
})
it('keeps the popup open if dismissal cannot be saved', async () => {
  render(<Popup />)
  await screen.findByRole('dialog')
  invoke.mockRejectedValueOnce(new Error('disk full'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Done' })))
  expect(screen.getByRole('alert')).toHaveTextContent('Try again')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it.each(['darwin', 'win32'])(
  'prepares and saves the meeting language inline on %s',
  async (nextPlatform) => {
    platform = nextPlatform
    meetingPending = true
    render(<Popup />)
    await screen.findByRole('dialog')
    const meetingSection = screen.getByRole('region', { name: 'Meeting language' })
    const picker = within(meetingSection).getByRole('button', { name: 'Meeting language: English' })
    await waitFor(() => expect(picker).toBeEnabled())
    await act(async () => fireEvent.click(picker))
    await act(async () => fireEvent.click(screen.getByRole('option', { name: 'German' })))
    expect(invoke).toHaveBeenCalledWith('whisper:prepare-meeting-language', 'de')
    expect(invoke).toHaveBeenCalledWith('prefs:set-meeting-language', 'de')
    expect(invoke).toHaveBeenCalledWith('prefs:confirm-onboarding-language')
    const channels = invoke.mock.calls.map(([channel]) => channel)
    expect(channels.indexOf('whisper:prepare-meeting-language')).toBeLessThan(
      channels.indexOf('prefs:set-meeting-language')
    )
    expect(savedMeetingLanguage).toBe('de')
    expect(screen.getByRole('button', { name: 'Meeting language: German' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('/')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Settings' })).not.toBeInTheDocument()
  }
)

it('retries a partial combined dismissal before closing', async () => {
  meetingPending = true
  render(<Popup />)
  await screen.findByRole('dialog')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Meeting language: English' })).toBeEnabled()
  )
  invoke
    .mockImplementationOnce(async () => {
      appearancePending = false
    })
    .mockRejectedValueOnce(new Error('disk full'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Done' })))
  expect(screen.getByRole('alert')).toHaveTextContent('Try again')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Done' })))
  expect(meetingPending).toBe(false)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it.each([true, false])(
  'Later postpones without persisting dismissal (combined: %s)',
  async (combined) => {
    meetingPending = combined
    const view = render(<Popup />)
    await screen.findByRole('dialog')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Later' })))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('prefs:dismiss-meeting-language-announcement')
    expect(invoke).not.toHaveBeenCalledWith('prefs:dismiss-ui-appearance-announcement')
    expect(meetingPending).toBe(combined)
    expect(appearancePending).toBe(true)
    view.unmount()
    render(<Popup />)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  }
)

it('Escape postpones both updates, like Later', async () => {
  meetingPending = true
  const view = render(<Popup />)
  const dialog = await screen.findByRole('dialog')
  await act(async () => fireEvent(dialog, new Event('cancel', { cancelable: true })))
  expect(meetingPending).toBe(true)
  expect(appearancePending).toBe(true)
  view.unmount()
  render(<Popup />)
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('prefs:get-ui-appearance-announcement-pending')
  )
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
})

it('keeps the previous meeting language when preparation fails', async () => {
  meetingPending = true
  render(<Popup />)
  const picker = await screen.findByRole('button', { name: 'Meeting language: English' })
  await waitFor(() => expect(picker).toBeEnabled())
  await act(async () => fireEvent.click(picker))
  invoke.mockRejectedValueOnce(new Error('model setup failed'))
  await act(async () => fireEvent.click(screen.getByRole('option', { name: 'German' })))
  expect(screen.getByRole('alert')).toHaveTextContent('Failed to save the meeting language')
  expect(invoke).not.toHaveBeenCalledWith('prefs:set-meeting-language', 'de')
  expect(savedMeetingLanguage).toBe('en')
  expect(picker).toHaveTextContent('English')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it.each([
  ['darwin', 'ENOSPC: no space left on device'],
  ['win32', 'There is not enough space on the disk.'],
  ['darwin', 'EDQUOT: disk quota exceeded']
])(
  'keeps the old language and allows retry after a disk-full download on %s: %s',
  async (nextPlatform, message) => {
    platform = nextPlatform
    meetingPending = true
    render(<Popup />)
    const picker = await screen.findByRole('button', { name: 'Meeting language: English' })
    await waitFor(() => expect(picker).toBeEnabled())
    await act(async () => fireEvent.click(picker))
    invoke.mockRejectedValueOnce(new Error(message))
    await act(async () => fireEvent.click(screen.getByRole('option', { name: 'German' })))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not enough disk space. Free up space and try again.'
    )
    expect(savedMeetingLanguage).toBe('en')
    expect(invoke).not.toHaveBeenCalledWith('prefs:set-meeting-language', 'de')
    expect(invoke).not.toHaveBeenCalledWith('prefs:confirm-onboarding-language')
    expect(picker).toHaveTextContent('English')
    expect(picker).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Later' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled()
    await act(async () => fireEvent.click(picker))
    await act(async () => fireEvent.click(screen.getByRole('option', { name: 'German' })))
    expect(savedMeetingLanguage).toBe('de')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  }
)

it('keeps Done and Later disabled until language preparation finishes', async () => {
  meetingPending = true
  render(<Popup />)
  const picker = await screen.findByRole('button', { name: 'Meeting language: English' })
  await waitFor(() => expect(picker).toBeEnabled())
  await act(async () => fireEvent.click(picker))
  let finish!: () => void
  invoke.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  await act(async () => fireEvent.click(screen.getByRole('option', { name: 'German' })))
  expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Later' })).toBeDisabled()
  expect(picker).toBeDisabled()
  expect(invoke).not.toHaveBeenCalledWith('prefs:set-meeting-language', 'de')
  await act(async () => finish())
  expect(savedMeetingLanguage).toBe('de')
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled()
})

it('waits for an unrelated modal to close', async () => {
  const modal = document.createElement('dialog')
  modal.open = true
  document.body.append(modal)
  render(<Popup />)
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('prefs:get-ui-appearance-announcement-pending')
  )
  expect(screen.queryAllByRole('dialog')).toEqual([modal])
  act(() => modal.remove())
  expect(await screen.findByRole('dialog')).toHaveTextContent('New')
})

it('the decorative greeting starts in the UI language and is hidden from assistive technology', async () => {
  render(<Popup />)
  const dialog = await screen.findByRole('dialog')
  const greeting = dialog.querySelector('[data-announcement-greeting]')!
  expect(greeting).toHaveAttribute('aria-hidden', 'true')
  expect(greeting.querySelector('[data-greeting-visible]')).toHaveTextContent('Hello')
  expect(greeting.querySelector('[data-greeting-visible]')).toHaveAttribute('lang', 'en')
  expect(screen.getByRole('dialog', { name: 'New' })).toBeInTheDocument()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'App language' })))
  await act(async () => fireEvent.click(screen.getByRole('option', { name: 'Français' })))
  expect(greeting.querySelector('[data-greeting-visible]')).toHaveTextContent('Bonjour')
})
