import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotesFeedback } from './NotesFeedback'
import { trackEvent } from '../services/analytics'

vi.mock('../services/analytics', () => ({ trackEvent: vi.fn() }))
const props = { meetingId: 'meeting-1', generationId: 'generation-1', engineVersion: 'v2.1' }
let sent: boolean
let consent: boolean
let sendResult: () => Promise<unknown>
const invoke = vi.fn(async (channel: string) => {
  if (channel === 'notes-feedback:state')
    return { available: true, sent, analyticsEnabled: consent }
  if (channel === 'notes-feedback:send') return sendResult()
  throw new Error('Unexpected IPC')
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  sent = false
  consent = false
  sendResult = async () => {
    sent = true
    return { status: 'sent', analyticsEnabled: consent }
  }
  vi.stubGlobal('electronAPI', { invoke })
})

describe('NotesFeedback', () => {
  it.each([false, true])(
    'keeps unavailable feedback hidden when the key is missing (dev=%s)',
    async (dev) => {
      vi.stubEnv('DEV', dev)
      vi.stubEnv('VITE_POSTHOG_KEY', '')
      invoke.mockResolvedValueOnce({ available: false, sent: false, analyticsEnabled: false })
      const view = render(<NotesFeedback {...props} />)
      await waitFor(() => expect(invoke).toHaveBeenCalled())
      expect(view.container).toBeEmptyDOMElement()
    }
  )

  it.each([false, true])(
    'always discloses the payload with analytics %s; selecting sends nothing',
    async (enabled) => {
      consent = enabled
      render(<NotesFeedback {...props} />)
      expect(await screen.findByText('What gets sent to AutoDoc')).toBeVisible()
      expect(
        screen.getByText(
          'Notes, transcripts, recordings, logs, and meeting titles are not attached.'
        )
      ).toBeVisible()
      const user = userEvent.setup()
      await user.click(screen.getByRole('radio', { name: 'Useful', exact: true }))
      expect(invoke.mock.calls.some(([channel]) => channel === 'notes-feedback:send')).toBe(false)
      if (!enabled) {
        expect(screen.getByText('Analytics is off and will stay off.')).toBeVisible()
        expect(trackEvent).not.toHaveBeenCalled()
      }
      await user.click(screen.getByRole('button', { name: 'Send rating' }))
      expect(await screen.findByRole('status')).toHaveTextContent('Thanks.')
      expect(invoke).toHaveBeenCalledWith('notes-feedback:send', {
        meetingId: props.meetingId,
        generationId: props.generationId,
        rating: 'useful',
        comment: ''
      })
    }
  )

  it('preserves optional detail after failure, retries, then shows a compact receipt on revisit', async () => {
    const view = render(<NotesFeedback {...props} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: 'Not useful', exact: true }))
    await user.click(screen.getByRole('button', { name: 'Add detail (optional)' }))
    await user.type(screen.getByRole('textbox'), 'Missing decisions')
    sendResult = async () => ({ status: 'failed', code: 'send-failed' })
    await user.click(screen.getByRole('button', { name: 'Send feedback' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your response is still here')
    expect(screen.getByRole('textbox')).toHaveValue('Missing decisions')
    sendResult = async () => {
      sent = true
      return { status: 'sent', analyticsEnabled: false }
    }
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Analytics is still off.')
    await waitFor(() => expect(screen.getByRole('status')).toHaveFocus())
    view.unmount()
    render(<NotesFeedback {...props} />)
    expect(await screen.findByText('✓ Feedback sent')).toBeVisible()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('disables duplicate submissions while sending', async () => {
    sendResult = () => new Promise(() => {})
    render(<NotesFeedback {...props} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: 'Useful', exact: true }))
    await user.dblClick(screen.getByRole('button', { name: 'Send rating' }))
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'notes-feedback:send')).toHaveLength(
      1
    )
  })
})
