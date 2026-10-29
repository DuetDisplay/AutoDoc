import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { AnnouncementQueue } from './AnnouncementQueue'
import { I18nProvider } from '../services/i18n'
import { ThemeProvider } from '../services/theme'

const invoke = vi.fn()
const visibility = vi.fn()
let meetingPending = false
let appearancePending = true
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  meetingPending = false
  appearancePending = true
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'prefs:get-meeting-language-announcement-pending') return meetingPending
    if (channel === 'prefs:get-ui-appearance-announcement-pending') return appearancePending
    if (channel === 'prefs:dismiss-ui-appearance-announcement') appearancePending = false
    if (channel === 'prefs:get-ui-language') return 'en'
    if (channel === 'prefs:get-appearance') return 'light'
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
  return <output>{location.pathname}</output>
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
  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('AutoDoc now speaks your language')
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Dark mode' })))
  expect(invoke).toHaveBeenCalledWith('prefs:set-appearance', 'dark')
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'App language' })))
  await act(async () => fireEvent.click(screen.getByRole('option', { name: 'Deutsch' })))
  expect(invoke).toHaveBeenCalledWith('prefs:set-ui-language', 'de')
  expect(dialog).toHaveTextContent('AutoDoc spricht jetzt Ihre Sprache')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Fertig' })))
  expect(invoke).toHaveBeenCalledWith('prefs:dismiss-ui-appearance-announcement')
  expect(appearancePending).toBe(false)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('queues the meeting-language announcement first, with only one modal open', async () => {
  meetingPending = true
  render(<Popup />)
  expect(await screen.findByRole('dialog')).toHaveTextContent('Your meetings, in your language')
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Got it' })))
  await waitFor(() =>
    expect(screen.getByRole('dialog')).toHaveTextContent('AutoDoc now speaks your language')
  )
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
})
it('persists Escape dismissal and never shows for a non-pending profile', async () => {
  const view = render(<Popup />)
  const dialog = await screen.findByRole('dialog')
  await act(async () => fireEvent(dialog, new Event('cancel', { cancelable: true })))
  expect(invoke).toHaveBeenCalledWith('prefs:dismiss-ui-appearance-announcement')
  view.unmount()
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

it('dismisses and opens Settings through the secondary action', async () => {
  render(<Popup />)
  await screen.findByRole('dialog')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open Settings' })))
  expect(invoke).toHaveBeenCalledWith('prefs:dismiss-ui-appearance-announcement')
  expect(screen.getByRole('status')).toHaveTextContent('/settings')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
