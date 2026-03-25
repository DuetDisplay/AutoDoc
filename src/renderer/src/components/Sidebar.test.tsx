import { render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Sidebar } from './Sidebar'

beforeEach(() => {
  window.electronAPI = {
    send: vi.fn(),
    invoke: vi.fn((channel: string) => {
      if (channel === 'ollama:check-status') return Promise.resolve(true)
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
      </MemoryRouter>
    )
  })
  return result!
}

describe('Sidebar', () => {
  it('renders the app name', async () => {
    await renderSidebar()
    expect(screen.getByText('murmur')).toBeInTheDocument()
  })

  it('renders all navigation links', async () => {
    await renderSidebar()
    expect(screen.getByText('Upcoming')).toBeInTheDocument()
    expect(screen.getByText('Recordings')).toBeInTheDocument()
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
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {}),
    } as any

    await renderSidebar()
    expect(screen.getByText('Ollama disconnected')).toBeInTheDocument()
  })
})
