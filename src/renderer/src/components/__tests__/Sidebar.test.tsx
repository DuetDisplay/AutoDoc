import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from '../Sidebar'
import { createElectronApiMock } from '../../test/fixtures'

function renderSidebar(ollamaStatus: Record<string, unknown>): void {
  window.electronAPI = createElectronApiMock({
    'ollama:get-setup-status': ollamaStatus,
    // The serve answers even though the notes model cannot be loaded.
    'ollama:check-status': true,
    'whisper:get-setup-status': { phase: 'ready', percent: 100 },
    'support:get-availability': false
  }) as any
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>
  )
}

describe('Sidebar Ollama status', () => {
  beforeEach(() => {
    window.electronAPI = createElectronApiMock() as any
  })

  it('shows connected when setup is ready and the serve answers', async () => {
    renderSidebar({ phase: 'ready', percent: 100 })
    expect(await screen.findByText('Ollama connected')).toBeInTheDocument()
  })

  it('does not claim Ollama is connected when the notes model cannot be loaded', async () => {
    renderSidebar({
      phase: 'error',
      percent: 0,
      error: "AutoDoc couldn't load the notes model.",
      failedStep: 'model_load'
    })

    expect(await screen.findByText('Notes model unavailable')).toBeInTheDocument()
    // Let the status poll (which reports the serve as running) settle.
    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('ollama:check-status')
    })
    expect(screen.queryByText('Ollama connected')).not.toBeInTheDocument()
  })
})
