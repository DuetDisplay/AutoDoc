import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Sidebar } from './Sidebar'
import { createElectronApiMock } from '../test/fixtures'

const defaultSetupStatus = { phase: 'ready', percent: 100 }
const trackEventMock = vi.hoisted(() => vi.fn())

vi.mock('../services/analytics', () => ({
  trackEvent: trackEventMock
}))

beforeEach(() => {
  trackEventMock.mockReset()
  window.electronAPI = {
    send: vi.fn(),
    invoke: vi.fn((channel: string) => {
      if (channel === 'ollama:check-status') return Promise.resolve(true)
      if (channel === 'ollama:get-setup-status') return Promise.resolve(defaultSetupStatus)
      if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
      if (channel === 'support:get-availability') return Promise.resolve(true)
      if (channel === 'support:open-email') return Promise.resolve({ status: 'opened' })
      return Promise.resolve(undefined)
    }),
    on: vi.fn(() => () => {})
  } as any
})

async function renderSidebar() {
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    )
  })
  return result!
}

describe('Sidebar', () => {
  it('renders the app name', async () => {
    await renderSidebar()
    expect(screen.getByText('AutoDoc')).toBeInTheDocument()
  })

  it('renders all navigation links', async () => {
    await renderSidebar()
    expect(screen.getByText('Upcoming')).toBeInTheDocument()
    expect(screen.getByText('AI Notes')).toBeInTheDocument()
    expect(screen.getByText('Search')).toBeInTheDocument()
    expect(screen.getByText('Ask AI')).toBeInTheDocument()
  })

  it('renders settings link', async () => {
    await renderSidebar()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('renders an accessible Email Us action in the sidebar footer', async () => {
    await renderSidebar()

    expect(screen.getByRole('button', { name: 'Email Us' })).toBeEnabled()
  })

  it('opens a main-owned email draft without renderer content', async () => {
    await renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'Email Us' }))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('support:open-email', 'sidebar')
    })
    expect(screen.queryByText('Draft opened in your email app.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Email Us' })).toBeEnabled()
    expect(trackEventMock).toHaveBeenCalledWith('support_email_requested', {
      surface: 'sidebar'
    })
    expect(trackEventMock).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'sidebar',
      outcome: 'draft_opened'
    })
  })

  it('prevents repeated activation while the mail client request is pending', async () => {
    let resolveOpenEmail: ((value: { status: 'opened' }) => void) | undefined
    const openEmailPromise = new Promise<{ status: 'opened' }>((resolve) => {
      resolveOpenEmail = resolve
    })
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'ollama:check-status') return Promise.resolve(true)
        if (channel === 'ollama:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'support:get-availability') return Promise.resolve(true)
        if (channel === 'support:open-email') return openEmailPromise
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {})
    } as unknown as typeof window.electronAPI

    await renderSidebar()
    const button = screen.getByRole('button', { name: 'Email Us' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(screen.getByRole('button', { name: 'Opening email…' })).toBeDisabled()
    expect(
      vi
        .mocked(window.electronAPI.invoke)
        .mock.calls.filter(([channel]) => channel === 'support:open-email')
    ).toHaveLength(1)

    await act(async () => {
      resolveOpenEmail?.({ status: 'opened' })
      await openEmailPromise
    })
  })

  it('offers a copy fallback when no mail client opens', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'ollama:check-status') return Promise.resolve(true)
        if (channel === 'ollama:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'support:get-availability') return Promise.resolve(true)
        if (channel === 'support:open-email') {
          return Promise.resolve({
            status: 'copy-required',
            address: 'team@getautodoc.com'
          })
        }
        if (channel === 'support:copy-email') return Promise.resolve({ status: 'copied' })
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {})
    } as unknown as typeof window.electronAPI

    await renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Email Us' }))

    const copyButton = await screen.findByRole('button', { name: 'Copy email address' })
    expect(screen.getByText('team@getautodoc.com')).toBeInTheDocument()
    fireEvent.click(copyButton)

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('support:copy-email', 'sidebar')
      expect(screen.getByText('Email address copied.')).toBeInTheDocument()
    })
    expect(trackEventMock).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'sidebar',
      outcome: 'copy_required'
    })
    expect(trackEventMock).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'sidebar',
      outcome: 'address_copied'
    })
  })

  it('reports a main-process copy failure without claiming success', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'ollama:check-status') return Promise.resolve(true)
        if (channel === 'ollama:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'support:get-availability') return Promise.resolve(true)
        if (channel === 'support:open-email') {
          return Promise.resolve({
            status: 'copy-required',
            address: 'team@getautodoc.com'
          })
        }
        if (channel === 'support:copy-email') {
          return Promise.resolve({ status: 'copy-failed' })
        }
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {})
    } as unknown as typeof window.electronAPI

    await renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Email Us' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy email address' }))

    await waitFor(() => {
      expect(screen.getByText('Couldn’t copy. Select the address above.')).toBeInTheDocument()
    })
    expect(trackEventMock).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'sidebar',
      outcome: 'copy_failed'
    })
  })

  it('disables Email Us with an explanation when this build has no support address', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'ollama:check-status') return Promise.resolve(true)
        if (channel === 'ollama:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'support:get-availability') return Promise.resolve(false)
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {})
    } as unknown as typeof window.electronAPI

    await renderSidebar()

    expect(screen.getByRole('button', { name: 'Email Us' })).toBeDisabled()
    expect(screen.getByText('Email isn’t configured in this build.')).toBeInTheDocument()
    expect(window.electronAPI.invoke).not.toHaveBeenCalledWith('support:open-email')
  })

  it('shows Ollama connected status', async () => {
    await renderSidebar()
    expect(screen.getByText('Ollama connected')).toBeInTheDocument()
  })

  it('shows Ollama disconnected status', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'ollama:check-status') return Promise.resolve(false)
        if (channel === 'ollama:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {})
    } as any

    await renderSidebar()
    expect(screen.getByText('Ollama disconnected')).toBeInTheDocument()
  })

  it('shows Ollama startup progress while reconnecting', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'ollama:check-status') return Promise.resolve(false)
        if (channel === 'ollama:get-setup-status') {
          return Promise.resolve({ phase: 'starting', percent: 0 })
        }
        if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {})
    } as any

    await renderSidebar()
    expect(screen.getByText('Starting Ollama runtime...')).toBeInTheDocument()
  })

  it('shows Ollama connected instead of stale startup progress when the runtime is already running', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'ollama:check-status') return Promise.resolve(true)
        if (channel === 'ollama:get-setup-status') {
          return Promise.resolve({ phase: 'starting', percent: 0 })
        }
        if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {})
    } as any

    await renderSidebar()
    await waitFor(() => {
      expect(screen.getByText('Ollama connected')).toBeInTheDocument()
    })
    expect(screen.queryByText('Starting Ollama runtime...')).not.toBeInTheDocument()
  })

  it('shows whisper download progress when downloading speech model', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'ollama:check-status') return Promise.resolve(true)
        if (channel === 'ollama:get-setup-status') return Promise.resolve(defaultSetupStatus)
        if (channel === 'whisper:get-setup-status') {
          return Promise.resolve({ phase: 'downloading-model', percent: 42 })
        }
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {})
    } as any

    await renderSidebar()
    expect(screen.getByText('Downloading speech model... 42%')).toBeInTheDocument()
  })

  it('clears the speaker model download banner once setup reports ready', async () => {
    const api = createElectronApiMock({
      'ollama:check-status': true,
      'ollama:get-setup-status': defaultSetupStatus,
      'whisper:get-setup-status': { phase: 'downloading-speaker-model', percent: 75 }
    })
    window.electronAPI = api as any

    await renderSidebar()
    expect(screen.getByText('Downloading speaker model... 75%')).toBeInTheDocument()

    await act(async () => {
      api.emit('whisper:setup-progress', { phase: 'ready', percent: 100 })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.queryByText('Downloading speaker model... 75%')).not.toBeInTheDocument()
      expect(screen.queryByText('Downloading speaker model... 100%')).not.toBeInTheDocument()
    })
  })

  it('does not show the launch-time checking banner for whisper setup', async () => {
    vi.useFakeTimers()
    try {
      const whisperStatuses = [
        { phase: 'checking', percent: 0 },
        { phase: 'ready', percent: 100 }
      ]

      window.electronAPI = {
        send: vi.fn(),
        invoke: vi.fn((channel: string) => {
          if (channel === 'ollama:check-status') return Promise.resolve(true)
          if (channel === 'ollama:get-setup-status') return Promise.resolve(defaultSetupStatus)
          if (channel === 'whisper:get-setup-status') {
            return Promise.resolve(whisperStatuses.shift() ?? defaultSetupStatus)
          }
          return Promise.resolve(undefined)
        }),
        on: vi.fn(() => () => {})
      } as any

      await renderSidebar()
      expect(screen.queryByText('Checking transcription engine...')).not.toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500)
      })

      expect(screen.queryByText('Checking transcription engine...')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
