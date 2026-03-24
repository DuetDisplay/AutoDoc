import '@testing-library/jest-dom'

vi.stubGlobal('electronAPI', {
  send: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(() => vi.fn())
})
