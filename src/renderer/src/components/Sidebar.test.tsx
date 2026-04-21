import { render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Sidebar } from './Sidebar'
import { createElectronApiMock } from '../test/fixtures'

const defaultSetupStatus = { phase: 'ready', percent: 100 }

beforeEach(() => {
  window.electronAPI = {
    send: vi.fn(),
    invoke: vi.fn((channel: string) => {
      if (channel === 'ollama:check-status') return Promise.resolve(true)
      if (channel === 'ollama:get-setup-status') return Promise.resolve(defaultSetupStatus)
      if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
      return Promise.resolve(undefined)
    }),
    on: vi.fn(() => () => {}),
  } as any
})

async function renderSidebar() {
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
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
      on: vi.fn(() => () => {}),
    } as any

    await renderSidebar()
    expect(screen.getByText('Ollama disconnected')).toBeInTheDocument()
  })

  it('shows Ollama startup progress while reconnecting', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'ollama:check-status') return Promise.resolve(false)
        if (channel === 'ollama:get-setup-status') return Promise.resolve({ phase: 'starting', percent: 0 })
        if (channel === 'whisper:get-setup-status') return Promise.resolve(defaultSetupStatus)
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {}),
    } as any

    await renderSidebar()
    expect(screen.getByText('Starting local AI engine...')).toBeInTheDocument()
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
      on: vi.fn(() => () => {}),
    } as any

    await renderSidebar()
    expect(screen.getByText('Downloading speech model... 42%')).toBeInTheDocument()
  })

  it('clears the speaker model download banner once setup reports ready', async () => {
    const api = createElectronApiMock({
      'ollama:check-status': true,
      'ollama:get-setup-status': defaultSetupStatus,
      'whisper:get-setup-status': { phase: 'downloading-speaker-model', percent: 75 },
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
})
