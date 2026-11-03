import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
const originalPlatform = vi.hoisted(() => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
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
  vi.unstubAllGlobals()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function fixture(models: string[], retainSmall = false, profileModel?: string) {
  const installed = new Set(models)
  const manager = new OllamaManager({
    model: SMALL,
    retainLowSpecModel: () => retainSmall,
    ...(profileModel ? { resolveModel: async () => profileModel } : {})
  })
  vi.spyOn(manager, 'start').mockResolvedValue(undefined)
  vi.spyOn(manager, 'isServerRunning').mockResolvedValue(true)
  vi.spyOn(manager, 'listInstalledModels').mockImplementation(async () => [...installed])
  const pull = vi.spyOn(manager, 'pullModel').mockImplementation(async (model) => {
    installed.add(model!)
  })
  const remove = vi.spyOn(manager, 'deleteModel').mockImplementation(async (model) => {
    installed.delete(model)
  })
  return { manager, installed, pull, remove }
}

describe('notes model readiness', () => {
  it('prepares Qwen when setup had selected installed 3B, and rechecks after model removal', async () => {
    const { manager, installed, pull } = fixture([SMALL])
    await manager.startAndPull()
    await expect(manager.ensureNotesModelReady(QWEN)).resolves.toMatchObject({ activeModel: QWEN })
    expect(installed.has(QWEN)).toBe(true)
    installed.delete(QWEN)
    await manager.ensureNotesModelReady(QWEN)
    expect(pull).toHaveBeenCalledTimes(2)
  })

  it('joins simultaneous requests for the same missing model', async () => {
    const { manager, installed, pull } = fixture([])
    const gate = deferred()
    pull.mockImplementation(async (model) => {
      await gate.promise
      installed.add(model!)
    })
    const first = manager.ensureNotesModelReady(QWEN)
    const second = manager.ensureNotesModelReady(QWEN)
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1))
    gate.resolve()
    expect((await first).activeModel).toBe(QWEN)
    expect((await second).activeModel).toBe(QWEN)
  })

  it('uses installed legacy during the download and defers deleting it through job release', async () => {
    const { manager, installed, pull, remove } = fixture([LEGACY])
    const gate = deferred()
    pull.mockImplementation(async (model) => {
      await gate.promise
      installed.add(model!)
    })
    manager.beginNotesGeneration()
    expect((await manager.ensureNotesModelReady(QWEN)).activeModel).toBe(LEGACY)
    gate.resolve()
    await vi.waitFor(() => expect(installed.has(QWEN)).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remove).not.toHaveBeenCalled()
    expect(installed.has(LEGACY)).toBe(true)
    await manager.endNotesGeneration()
    expect(installed.has(LEGACY)).toBe(false)
  })

  it('retains installed 3B for a later CPU downgrade without adding it as a Qwen fallback', async () => {
    const { manager, installed, remove } = fixture([SMALL, QWEN], true)
    expect((await manager.ensureNotesModelReady(QWEN)).activeModel).toBe(QWEN)
    expect(remove).not.toHaveBeenCalledWith(SMALL)
    expect((await manager.ensureNotesModelReady(SMALL)).activeModel).toBe(SMALL)
    expect(installed.has(QWEN)).toBe(true)
  })

  it('does not claim readiness when a completed pull did not install the model', async () => {
    const { manager, pull } = fixture([])
    pull.mockResolvedValue(undefined)
    await expect(manager.ensureNotesModelReady(QWEN)).rejects.toThrow(/notes model setup/i)
  })

  it('does not mistake an unavailable inventory for an empty store and start a download', async () => {
    const { manager, pull, remove } = fixture([LEGACY])
    vi.mocked(manager.listInstalledModels).mockRestore()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    await expect(manager.ensureNotesModelReady(QWEN)).rejects.toThrow('inventory returned 503')
    expect(pull).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('waits for an already submitted idle delete before approving the next job model', async () => {
    const { manager, installed, remove } = fixture([LEGACY, QWEN])
    const deleting = deferred()
    remove.mockImplementation(async (model) => {
      await deleting.promise
      installed.delete(model)
    })
    const startup = manager.ensureNotesModelReady(QWEN)
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(LEGACY))
    manager.beginNotesGeneration()
    let approved = false
    const nextJob = manager.ensureNotesModelReady(SMALL).then((result) => {
      approved = true
      return result
    })
    await Promise.resolve()
    expect(approved).toBe(false)
    deleting.resolve()
    await startup
    expect((await nextJob).activeModel).toBe(SMALL)
    expect(installed.has(SMALL)).toBe(true)
    await manager.endNotesGeneration()
  })

  it('abandons stale cleanup when the preferred model changes during the retention check', async () => {
    const { manager, installed, remove } = fixture([SMALL, QWEN])
    const retention = deferred()
    const check = vi.fn(async () => {
      await retention.promise
      return false
    })
    ;(manager as any).retainLowSpecModel = check
    const startup = manager.ensureNotesModelReady(QWEN)
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce())
    const changed = manager.ensureNotesModelReady(SMALL)
    retention.resolve()
    await startup
    expect((await changed).activeModel).toBe(SMALL)
    expect(remove).not.toHaveBeenCalledWith(SMALL)
    expect(installed.has(SMALL)).toBe(true)
  })

  it('does not let an old background Qwen pull overwrite a newer CPU selection', async () => {
    const { manager, installed, pull, remove } = fixture([LEGACY, SMALL], true)
    const download = deferred()
    pull.mockImplementation(async (model) => {
      await download.promise
      installed.add(model!)
    })
    manager.beginNotesGeneration()
    await manager.ensureNotesModelReady(QWEN)
    await manager.ensureNotesModelReady(SMALL)
    download.resolve()
    await vi.waitFor(() => expect(installed.has(QWEN)).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.getModel()).toBe(SMALL)
    await manager.endNotesGeneration()
    expect(remove).not.toHaveBeenCalledWith(SMALL)
  })

  it('keeps an installed legacy fallback if its background download fails', async () => {
    const { manager, installed, pull, remove } = fixture([LEGACY])
    pull.mockRejectedValue(new Error('offline'))
    expect((await manager.ensureNotesModelReady(QWEN)).activeModel).toBe(LEGACY)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(installed.has(LEGACY)).toBe(true)
    expect(remove).not.toHaveBeenCalled()
  })

  it('does not approve or clean up after stop invalidates an in-flight preparation', async () => {
    const { manager, installed, pull, remove } = fixture([])
    const gate = deferred()
    pull.mockImplementation(async (model) => {
      await gate.promise
      installed.add(model!)
    })
    vi.spyOn(manager as any, 'killProcessOnPort').mockReturnValue(undefined)
    vi.spyOn(manager as any, 'killManagedLlamaServers').mockReturnValue(undefined)
    const preparing = manager.ensureNotesModelReady(QWEN)
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'OLLAMA_START_CANCELLED' })
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1))
    manager.stop()
    gate.resolve()
    await rejected
    expect(remove).not.toHaveBeenCalled()
  })
})


it('keeps the profile-selected Ask AI model when a real Windows manager prepares another notes model', async () => {
  const { manager } = fixture([SMALL,QWEN],true,QWEN)
  await manager.startAndPull()
  expect(manager.getAskAiModel()).toBe(QWEN)
  expect((await manager.ensureNotesModelReady(SMALL)).activeModel).toBe(SMALL)
  expect(manager.getModel()).toBe(SMALL)
  expect(manager.getAskAiModel()).toBe(QWEN)
})
it('keeps startup legacy through a notes downgrade, then changes Ask AI to Qwen when its pull completes', async () => {
  const { manager, installed, pull, remove } = fixture([LEGACY,SMALL],true,QWEN)
  const gate=deferred()
  pull.mockImplementation(async model=>{await gate.promise;installed.add(model!)})
  await manager.startAndPull()
  expect(manager.getAskAiModel()).toBe(LEGACY)
  manager.beginNotesGeneration()
  await manager.ensureNotesModelReady(SMALL)
  expect(manager.getModel()).toBe(SMALL)
  expect(manager.getAskAiModel()).toBe(LEGACY)
  await manager.endNotesGeneration()
  expect(remove).not.toHaveBeenCalledWith(LEGACY)
  gate.resolve()
  await vi.waitFor(()=>expect(manager.getAskAiModel()).toBe(QWEN))
  expect(manager.getModel()).toBe(SMALL)
})

it('moves Ask AI to the profile model when a later notes job finishes a pull that startup failed, then deletes legacy', async () => {
  const { manager, installed, pull, remove } = fixture([LEGACY], false, QWEN)
  pull.mockRejectedValueOnce(new Error('offline'))
  await manager.startAndPull()
  await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(manager.getAskAiModel()).toBe(LEGACY)
  expect(installed.has(QWEN)).toBe(false)

  expect((await manager.ensureNotesModelReady(QWEN)).activeModel).toBe(LEGACY)
  await vi.waitFor(() => expect(installed.has(LEGACY)).toBe(false))
  expect(pull).toHaveBeenCalledTimes(2)
  expect(manager.getAskAiModel()).toBe(QWEN)
  expect(installed.has(QWEN)).toBe(true)
  expect(remove).toHaveBeenCalledWith(LEGACY)
})

it('keeps legacy for Ask AI until the profile pull completes and waits for the active job before deleting it', async () => {
  const { manager, installed, pull, remove } = fixture([LEGACY], false, QWEN)
  pull.mockRejectedValueOnce(new Error('offline'))
  await manager.startAndPull()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const gate = deferred()
  pull.mockImplementation(async (model) => {
    await gate.promise
    installed.add(model!)
  })
  manager.beginNotesGeneration()
  await manager.ensureNotesModelReady(QWEN)
  expect(manager.getAskAiModel()).toBe(LEGACY)
  gate.resolve()
  await vi.waitFor(() => expect(manager.getAskAiModel()).toBe(QWEN))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(remove).not.toHaveBeenCalled()
  await manager.endNotesGeneration()
  expect(installed.has(LEGACY)).toBe(false)
  expect(installed.has(manager.getAskAiModel())).toBe(true)
})

it('does not treat a per-job override as the Ask AI model', async () => {
  const { manager, installed, remove } = fixture([QWEN], false, QWEN)
  await manager.startAndPull()
  expect(manager.getAskAiModel()).toBe(QWEN)
  expect((await manager.ensureNotesModelReady(SMALL)).activeModel).toBe(SMALL)
  expect(installed.has(SMALL)).toBe(true)
  expect(manager.getModel()).toBe(SMALL)
  expect(manager.getAskAiModel()).toBe(QWEN)
  expect(remove).not.toHaveBeenCalledWith(QWEN)
  expect(installed.has(QWEN)).toBe(true)
})

it('keeps a low-spec profile model for Ask AI when a notes job overrides to Qwen', async () => {
  const { manager, installed, remove } = fixture([SMALL], false, SMALL)
  await manager.startAndPull()
  expect((await manager.ensureNotesModelReady(QWEN)).activeModel).toBe(QWEN)
  expect(manager.getAskAiModel()).toBe(SMALL)
  // Cleanup for the Qwen job would otherwise delete the small model Ask AI still uses.
  expect(remove).not.toHaveBeenCalledWith(SMALL)
  expect(installed.has(SMALL)).toBe(true)
})
