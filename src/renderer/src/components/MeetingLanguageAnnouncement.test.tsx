import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { MeetingLanguageAnnouncement } from './MeetingLanguageAnnouncement'

const invoke = vi.fn()
const visibility = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockImplementation(
    async (channel: string) => channel === 'prefs:get-meeting-language-announcement-pending'
  )
  window.electronAPI = { invoke, on: vi.fn(), send: vi.fn() } as any
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})
function Location() {
  const { pathname, search } = useLocation()
  return (
    <output>
      {pathname}
      {search}
    </output>
  )
}
function Popup({ suppressed = false }: { suppressed?: boolean }) {
  return (
    <MemoryRouter>
      <MeetingLanguageAnnouncement suppressed={suppressed} onVisibilityChange={visibility} />
      <Location />
    </MemoryRouter>
  )
}
it('explains the feature and opens the meeting language setting after persisting dismissal', async () => {
  render(<Popup />)
  expect(await screen.findByRole('dialog')).toHaveTextContent('27 meeting languages')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose language' })))
  expect(invoke).toHaveBeenCalledWith('prefs:dismiss-meeting-language-announcement')
  expect(screen.getByRole('status')).toHaveTextContent('/settings?section=meeting-language')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('dismisses with Got it without navigating', async () => {
  render(<Popup />)
  await screen.findByRole('dialog')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Got it' })))
  expect(invoke).toHaveBeenCalledWith('prefs:dismiss-meeting-language-announcement')
  expect(screen.getByRole('status')).toHaveTextContent('/')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('waits while recording or another prompt needs attention', async () => {
  const view = render(<Popup suppressed />)
  await waitFor(() => expect(invoke).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  view.rerender(<Popup />)
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
})
it('stays hidden for users who are not eligible', async () => {
  invoke.mockResolvedValue(false)
  render(<Popup />)
  await waitFor(() => expect(invoke).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('keeps the dialog open when saving fails and lets the user retry', async () => {
  render(<Popup />)
  await screen.findByRole('dialog')
  invoke.mockRejectedValueOnce(new Error('disk full'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Got it' })))
  expect(screen.getByRole('alert')).toHaveTextContent('Try again')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Got it' })))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('persists dismissal on Escape', async () => {
  render(<Popup />)
  const dialog = await screen.findByRole('dialog')
  await act(async () => fireEvent(dialog, new Event('cancel', { cancelable: true })))
  expect(invoke).toHaveBeenCalledWith('prefs:dismiss-meeting-language-announcement')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
