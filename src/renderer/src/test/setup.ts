import '@testing-library/jest-dom'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })
})

vi.stubGlobal('electronAPI', {
  send: vi.fn(),
  invoke: vi.fn().mockResolvedValue({}),
  on: vi.fn(() => vi.fn())
})
