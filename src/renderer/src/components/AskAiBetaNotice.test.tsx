import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AskAiBetaNotice } from './AskAiBetaNotice'
import { installMockElectronApi } from '../test/fixtures'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})

it('stays hidden when the notice was already dismissed', async () => {
  installMockElectronApi({ 'prefs:get-ask-ai-beta-notice-pending': false })
  render(<AskAiBetaNotice onClosed={vi.fn()} />)
  await act(async () => {})
  expect(document.querySelector('dialog')).toBeNull()
})

it('shows once, saves the dismissal and returns focus through onClosed', async () => {
  const api = installMockElectronApi({ 'prefs:get-ask-ai-beta-notice-pending': true })
  const onClosed = vi.fn()
  render(<AskAiBetaNotice onClosed={onClosed} />)
  const dialog = await screen.findByRole('dialog', { name: 'Ask AI is in beta' })
  expect(dialog).toHaveAttribute('open')
  expect(dialog).toHaveTextContent(/Answers can miss details/)
  fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
  await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1))
  expect(api.invoke).toHaveBeenCalledWith('prefs:dismiss-ask-ai-beta-notice')
  expect(document.querySelector('dialog')).toBeNull()
})

it('still closes for this session when saving the dismissal fails', async () => {
  installMockElectronApi({
    'prefs:get-ask-ai-beta-notice-pending': true,
    'prefs:dismiss-ask-ai-beta-notice': () => {
      throw new Error('disk full')
    }
  })
  const onClosed = vi.fn()
  render(<AskAiBetaNotice onClosed={onClosed} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Got it' }))
  await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1))
  expect(document.querySelector('dialog')).toBeNull()
})

it('waits for another open dialog to close instead of stacking', async () => {
  installMockElectronApi({ 'prefs:get-ask-ai-beta-notice-pending': true })
  const other = document.createElement('dialog')
  other.setAttribute('open', '')
  document.body.append(other)
  render(<AskAiBetaNotice onClosed={vi.fn()} />)
  await act(async () => {})
  expect(document.querySelector('dialog[data-ask-ai-beta-notice][open]')).toBeNull()
  await act(async () => {
    other.removeAttribute('open')
  })
  await waitFor(() =>
    expect(document.querySelector('dialog[data-ask-ai-beta-notice][open]')).not.toBeNull()
  )
  other.remove()
})
