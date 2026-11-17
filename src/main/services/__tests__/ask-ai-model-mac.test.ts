import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
const originalPlatform = vi.hoisted(() => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  return original
})
import { OllamaManager } from '../ollama-manager'
import {
  DEFAULT_OLLAMA_MODEL as QWEN,
  LOW_SPEC_MAC_OLLAMA_MODEL as SMALL,
  LEGACY_OLLAMA_MODEL as LEGACY
} from '../../../shared/constants'

vi.mock('electron', () => ({ app: { getPath: () => '/unused', isPackaged: false } }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))
afterAll(() =>
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
)
afterEach(() => {
  vi.restoreAllMocks()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('Ask AI model on macOS', () => {
  it('stays on legacy while the profile model downloads, moves after, and ignores per-job model changes', async () => {
    const installed = new Set([LEGACY])
    const manager = new OllamaManager({ model: SMALL, resolveModel: async () => QWEN })
    vi.spyOn(manager, 'start').mockResolvedValue(undefined)
    vi.spyOn(manager, 'isServerRunning').mockResolvedValue(true)
    vi.spyOn(manager, 'listInstalledModels').mockImplementation(async () => [...installed])
    const gate = deferred()
    vi.spyOn(manager, 'pullModel').mockImplementation(async (model) => {
      await gate.promise
      installed.add(model!)
    })
    const remove = vi.spyOn(manager, 'deleteModel').mockImplementation(async (model) => {
      installed.delete(model)
    })

    await manager.startAndPull()
    expect(manager.getModel()).toBe(LEGACY)
    expect(manager.getAskAiModel()).toBe(LEGACY)

    // A per-job notes model change must not move Ask AI or free the legacy model it uses.
    manager.setModel(SMALL)
    expect(manager.getAskAiModel()).toBe(LEGACY)
    expect(remove).not.toHaveBeenCalled()

    gate.resolve()
    await vi.waitFor(() => expect(manager.getAskAiModel()).toBe(QWEN))
    await vi.waitFor(() => expect(installed.has(LEGACY)).toBe(false))
    expect(installed.has(manager.getAskAiModel())).toBe(true)

    manager.setModel(SMALL)
    expect(manager.getAskAiModel()).toBe(QWEN)
  })
})
