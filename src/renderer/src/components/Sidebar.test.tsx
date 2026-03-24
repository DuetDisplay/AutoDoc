import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { Sidebar } from './Sidebar'

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>
  )
}

describe('Sidebar', () => {
  it('renders the app name', () => {
    renderSidebar()
    expect(screen.getByText('AutoDoc')).toBeInTheDocument()
  })

  it('renders all navigation links', () => {
    renderSidebar()
    expect(screen.getByText('Upcoming')).toBeInTheDocument()
    expect(screen.getByText('Recordings')).toBeInTheDocument()
    expect(screen.getByText('Search')).toBeInTheDocument()
    expect(screen.getByText('Ask AI')).toBeInTheDocument()
  })

  it('renders settings link', () => {
    renderSidebar()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('renders Ollama status indicator', () => {
    renderSidebar()
    expect(screen.getByText(/ollama/i)).toBeInTheDocument()
  })
})
