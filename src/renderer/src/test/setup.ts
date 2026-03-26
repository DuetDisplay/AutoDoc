import '@testing-library/jest-dom'

vi.stubGlobal('electronAPI', {
  send: vi.fn(),
  invoke: vi.fn().mockResolvedValue({}),
  on: vi.fn(() => vi.fn())
})
