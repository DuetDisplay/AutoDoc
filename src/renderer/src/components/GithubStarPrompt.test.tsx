import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GithubStarPrompt } from './GithubStarPrompt'
let focused = true
let invoke: ReturnType<typeof vi.fn>
beforeEach(() => {
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) =>
    window.setTimeout(() => fn(0), 0)
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  invoke = vi.fn(async (channel: string) =>
    channel === 'github-star:reserve' ? 'reservation' : true
  )
  window.electronAPI = { invoke, on: vi.fn(() => () => {}), send: vi.fn() } as any
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Star on GitHub' })).toBeEnabled())
}
describe('GitHub star card', () => {
  it('waits for the notes list before asking and confirms a visible impression', async () => {
    const { rerender } = render(<GithubStarPrompt ready={false} />)
    expect(invoke).not.toHaveBeenCalled()
    rerender(<GithubStarPrompt />)
    await ready()
    expect(invoke).toHaveBeenCalledWith('github-star:confirm', 'reservation')
  })
  it('does not pop up when processing or another critical UI finishes while notes stay open', async () => {
    const { rerender } = render(<GithubStarPrompt suppressed />)
    rerender(<GithubStarPrompt />)
    expect(invoke).not.toHaveBeenCalled()
    fireEvent.focus(window)
    await ready()
  })
  it('requires foreground visibility, and retries only on returning to the app', async () => {
    focused = false
    render(<GithubStarPrompt />)
    expect(invoke).not.toHaveBeenCalled()
    focused = true
    fireEvent.focus(window)
    await ready()
  })
  it('changes to thanks immediately and fades only after leaving and returning', async () => {
    render(<GithubStarPrompt />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Star on GitHub' }))
    expect(screen.getByText('Thanks for the support!')).toBeVisible()
    fireEvent.focus(window)
    expect(screen.getByText('Thanks for the support!')).toBeVisible()
    focused = false
    fireEvent.blur(window)
    focused = true
    fireEvent.focus(window)
    await waitFor(() =>
      expect(screen.queryByText('Thanks for the support!')).not.toBeInTheDocument()
    )
    expect(invoke).toHaveBeenCalledWith('github-star:open')
  })
  it.each(['No thanks', 'Dismiss'])('removes the card with %s', async (name) => {
    render(<GithubStarPrompt />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name }))
    expect(screen.queryByText('Enjoying AutoDoc?')).not.toBeInTheDocument()
  })
  it('offers an honest retry if the browser cannot open', async () => {
    invoke.mockImplementation(async (channel) =>
      channel === 'github-star:reserve' ? 'reservation' : channel !== 'github-star:open'
    )
    render(<GithubStarPrompt />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Star on GitHub' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t open GitHub. Try again.')
    expect(screen.queryByText('Thanks for the support!')).not.toBeInTheDocument()
  })
  it('removes an already-shown card when recording or critical UI begins', async () => {
    const { rerender } = render(<GithubStarPrompt />)
    await ready()
    await act(async () => {
      rerender(<GithubStarPrompt suppressed />)
    })
    rerender(<GithubStarPrompt />)
    expect(screen.queryByText('Enjoying AutoDoc?')).not.toBeInTheDocument()
  })
})
