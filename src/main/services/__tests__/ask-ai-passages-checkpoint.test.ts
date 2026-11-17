import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, expect, it, vi } from 'vitest'
import { AskAiPassages } from '../ask-ai-passages'
import type { IndexedMeeting } from '../meeting-index'
import { logAutodocEvent } from '../autodoc-log'
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
const storage = vi.hoisted(() => ({ dir: '/unused' }))
vi.mock('electron', () => ({
  app: { getPath: () => storage.dir, isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`unit:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^unit:/, '')
  }
}))
vi.mock('../windows-key-protection', () => ({
  protectWindowsRecordingKey: (key: Buffer) => Buffer.concat([Buffer.from('unit:'), key]),
  unprotectWindowsRecordingKey: (value: Buffer) => value.subarray(5)
}))
// Real AES-GCM and filename authentication; only OS key storage is mocked.
import { decryptJSON } from '../crypto'
import * as cacheCrypto from '../crypto'
beforeEach(() => vi.clearAllMocks())
function meeting(id: string, count = 1): IndexedMeeting {
  return {
    meetingId: id,
    title: 'Synthetic workshop',
    date: 0,
    dir: '/unused',
    sourceName: null,
    signature: id,
    transcriptChunks: [],
    noteEntries: Array.from({ length: count }, (_, i) => ({
      id: String(i),
      title: `Item ${i}`,
      content: `Synthetic fact ${i}.`,
      category: 'information',
      topic: null,
      owner: null,
      deadline: null,
      sources: []
    }))
  }
}
it('writes checkpoints off the main thread with identical authenticated cache contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-worker-write-'))
  try {
    storage.dir = dir
    const provider = {
      model: 'unit',
      isAvailable: async () => true,
      embed: async (texts: string[]) => texts.map(() => [1, 0])
    }
    const legacy = join(dir, 'legacy.enc'),
      worker = join(dir, 'worker.enc')
    const data = [meeting('saved', 3)]
    await new AskAiPassages(provider, legacy).prepare(data)
    const expected = await decryptJSON<{ version: string; rows: unknown[] }>(legacy)
    const mainEncrypt = vi.spyOn(cacheCrypto, 'encryptJSON')
    try {
      await new AskAiPassages(provider, worker).prepare(data, () => true, { checkpoint: true })
      expect(mainEncrypt).not.toHaveBeenCalled()
      expect(await decryptJSON(worker)).toEqual({ ...expected, coveredMeetingIds: ['saved'] })
      expect((await readFile(worker)).subarray(0, 4).toString()).toBe('ADOC')
      expect(await readdir(dir)).not.toContain(expect.stringMatching(/\.enc\.\w+\.enc$/))
    } finally {
      mainEncrypt.mockRestore()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('checkpoints periodically and on pause, then restores the persisted vectors without embedding again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-checkpoint-'))
  try {
    storage.dir = dir
    let permitted = true,
      embedded = 0
    const provider = {
      model: 'unit',
      isAvailable: async () => true,
      embed: vi.fn(async (texts: string[]) => {
        embedded += texts.length
        if (embedded >= 520) permitted = false
        return texts.map(() => [1, 0])
      })
    }
    const file = join(dir, 'cache', 'index.enc'),
      data = [meeting('sample', 520)]
    const index = new AskAiPassages(provider, file)
    expect(await index.prepare(data, () => permitted, { batchSize: 4, checkpoint: true })).toBe(
      'paused'
    )
    const writes = vi
      .mocked(logAutodocEvent)
      .mock.calls.map(([entry]) => entry)
      .filter((e) => e.message === 'Ask AI index checkpoint written')
    expect(writes.map((e) => [e.context?.reason, e.context?.vectors])).toEqual([
      ['periodic', 512],
      ['pause', 520]
    ])
    expect((await readFile(file)).subarray(0, 4).toString()).toBe('ADOC')
    await expect(decryptJSON(file)).resolves.toMatchObject({ rows: expect.any(Array) })
    expect(await readdir(join(dir, 'cache'))).toEqual(['index.enc'])
    const cached = { ...provider, embed: vi.fn() }
    const resumed = new AskAiPassages(cached, file)
    const progress = vi.fn()
    expect(
      await resumed.prepare(data, () => true, { checkpoint: true, onProgress: progress })
    ).toBe('ready')
    expect(progress).toHaveBeenLastCalledWith(520, 520, 0)
    expect(cached.embed).not.toHaveBeenCalled()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('serializes all concurrent prepare waiters, including different meeting snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-waiters-'))
  try {
    storage.dir = dir
    const releases: Array<() => void> = []
    let active = 0,
      peak = 0
    const provider = {
      model: 'unit',
      isAvailable: async () => true,
      embed: vi.fn(async (texts: string[]) => {
        peak = Math.max(peak, ++active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active--
        return texts.map(() => [1, 0])
      })
    }
    const index = new AskAiPassages(provider, join(dir, 'index.enc'))
    const first = index.prepare([meeting('a')])
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    const second = index.prepare([meeting('b')]),
      third = index.prepare([meeting('c')])
    releases[0]()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    expect(peak).toBe(1)
    releases[1]()
    await vi.waitFor(() => expect(releases).toHaveLength(3))
    releases[2]()
    await Promise.all([first, second, third])
    expect(peak).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('inspects a saved complete cache without inference and retains semantic coverage for newly added meetings only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-saved-ready-'))
  try {
    storage.dir = dir
    const provider = {
      model: 'unit',
      isAvailable: async () => true,
      embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    }
    const file = join(dir, 'index.enc'),
      original = meeting('saved', 2)
    await new AskAiPassages(provider, file).prepare([original])
    provider.embed.mockClear()
    const restored = new AskAiPassages(provider, file)
    expect(await restored.inspect([original])).toMatchObject({
      completed: 2,
      total: 2,
      semanticReady: true
    })
    const added = meeting('new')
    expect(await restored.inspect([original, added])).toMatchObject({
      completed: 2,
      total: 3,
      semanticReady: true
    })
    const edited = {
      ...original,
      signature: 'edited',
      noteEntries: meeting('edited', 2).noteEntries.map((e) => ({
        ...e,
        content: 'Different saved facts.'
      }))
    }
    expect(await restored.inspect([edited, added])).toMatchObject({ semanticReady: false })
    expect(provider.embed).not.toHaveBeenCalled()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('keeps flag-off pruning and persistence when the gate closes after the last batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-final-gate-'))
  try {
    storage.dir = dir
    let allowed = true
    const provider = {
      model: 'unit',
      isAvailable: async () => true,
      embed: async (texts: string[]) => {
        allowed = false
        return texts.map(() => [1, 0])
      }
    }
    const file = join(dir, 'index.enc'),
      index = new AskAiPassages(provider, file)
    await index.prepare([meeting('obsolete')])
    allowed = true
    expect(await index.prepare([meeting('saved')], () => allowed)).toBe('ready')
    expect((await decryptJSON<{ rows: unknown[] }>(file)).rows).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('skips a pause checkpoint when no new vectors were added', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-unchanged-pause-'))
  try {
    storage.dir = dir
    const provider = { model: 'unit', isAvailable: async () => true, embed: vi.fn() }
    const index = new AskAiPassages(provider, join(dir, 'index.enc'))
    const write = vi
      .spyOn(index as any, 'checkpoint')
      .mockRejectedValue(new Error('disk write failed'))
    const abort = new AbortController()
    abort.abort()
    await expect(
      index.prepare([meeting('saved')], () => true, { checkpoint: true, signal: abort.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(write).not.toHaveBeenCalled()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('preserves the embedding error when the best-effort pause checkpoint also fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-pause-error-'))
  try {
    storage.dir = dir
    let calls = 0
    const provider = {
      model: 'unit',
      isAvailable: async () => true,
      embed: vi.fn(async (texts: string[]) => {
        if (++calls === 2) throw new Error('original embed failed')
        return texts.map(() => [1, 0])
      })
    }
    const index = new AskAiPassages(provider, join(dir, 'index.enc'))
    const write = vi
      .spyOn(index as any, 'checkpoint')
      .mockRejectedValue(new Error('disk write failed'))
    await expect(
      index.prepare([meeting('saved', 2)], () => true, { checkpoint: true, batchSize: 1 })
    ).rejects.toThrow('original embed failed')
    expect(write).toHaveBeenCalledWith('pause')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('uses cached-only retrieval without joining a cold index or semantic control preparation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-nonblocking-'))
  try {
    storage.dir = dir
    vi.stubEnv('AUTODOC_ASK_AI_INTENTS', 'semantic')
    const provider = {
      model: 'unit',
      isAvailable: async () => true,
      embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    }
    const index = new AskAiPassages(provider, join(dir, 'index.enc'))
    const prepare = vi.spyOn(index, 'prepare').mockImplementation(() => new Promise(() => {}))
    const data = [meeting('saved')]
    const control = await index.classifyControl('Synthetic fact?', data, true)
    expect(control).toBeNull()
    await index.retrieve('Synthetic fact?', data, undefined, undefined, () => false, true)
    await index.retrieveConversation(
      'Synthetic fact?',
      data,
      [],
      [],
      undefined,
      undefined,
      () => false,
      [],
      undefined,
      true
    )
    expect(prepare).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  }
})

it('invalidates restored readiness when the installed embedding identity changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-identity-'))
  try {
    storage.dir = dir
    let identity = 'unit:digest-a'
    const provider = {
      model: 'unit',
      get cacheIdentity() {
        return identity
      },
      isAvailable: async () => true,
      embed: async (texts: string[]) => texts.map(() => [1, 0])
    }
    const index = new AskAiPassages(provider, join(dir, 'index.enc')),
      data = [meeting('saved')]
    await index.prepare(data)
    expect(await index.inspect(data)).toMatchObject({ completed: 1, semanticReady: true })
    identity = 'unit:digest-b'
    expect(await index.inspect(data)).toMatchObject({ completed: 0, semanticReady: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('keeps new-meeting semantics when a previously empty recording receives notes, including after a legacy cache upgrade', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-empty-coverage-'))
  try {
    storage.dir = dir
    const provider = {
      model: 'unit',
      isAvailable: async () => true,
      embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    }
    const file = join(dir, 'index.enc'),
      saved = meeting('saved'),
      empty = { ...meeting('new'), noteEntries: [] }
    // Flag-off legacy cache has no coverage metadata.
    await new AskAiPassages(provider, file).prepare([saved])
    const upgraded = new AskAiPassages(provider, file)
    const upgradeWrite = vi.spyOn(upgraded as any, 'checkpoint')
    expect(await upgraded.inspect([saved, empty])).toMatchObject({
      completed: 1,
      total: 1,
      semanticReady: true
    })
    expect(upgradeWrite).not.toHaveBeenCalled()
    const mainDecrypt = vi.spyOn(cacheCrypto, 'decryptJSON')
    const inspectedAgain = new AskAiPassages(provider, file)
    const gatedWrite = vi.spyOn(inspectedAgain as any, 'checkpoint')
    await inspectedAgain.inspect([saved, empty])
    expect(mainDecrypt).not.toHaveBeenCalled()
    expect(gatedWrite).not.toHaveBeenCalled()
    mainDecrypt.mockRestore()
    await upgraded.prepare([saved, empty], () => true, { checkpoint: true })
    expect(upgradeWrite).toHaveBeenCalledTimes(1)
    expect((await decryptJSON<{ coveredMeetingIds: string[] }>(file)).coveredMeetingIds).toEqual([
      'saved'
    ])
    const added = { ...meeting('new'), signature: 'notes-arrived' }
    expect(await upgraded.inspect([saved, added])).toMatchObject({
      completed: 1,
      total: 2,
      semanticReady: true
    })
    const relaunched = new AskAiPassages(provider, file)
    expect(await relaunched.inspect([saved, added])).toMatchObject({
      completed: 1,
      total: 2,
      semanticReady: true
    })
    expect(provider.embed).toHaveBeenCalledTimes(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('revalidates an unknown saved digest before a cached-only semantic query', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-unknown-identity-'))
  try {
    storage.dir = dir
    let available = true,
      identity = 'unit:digest-a'
    const provider = {
      model: 'unit',
      get cacheIdentity() {
        return identity
      },
      get availabilityReason() {
        return available ? ('available' as const) : ('unreachable' as const)
      },
      isAvailable: async () => available,
      embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    }
    const file = join(dir, 'index.enc'),
      data = [meeting('saved')]
    await new AskAiPassages(provider, file).prepare(data)
    available = false
    identity = 'unit:unknown'
    const restored = new AskAiPassages(provider, file)
    expect(await restored.inspect(data)).toMatchObject({ semanticReady: true })
    available = true
    identity = 'unit:digest-b'
    provider.embed.mockClear()
    const answer = await restored.retrieveConversation(
      'Synthetic fact?',
      data,
      [],
      [],
      undefined,
      undefined,
      () => true,
      [],
      undefined,
      true
    )
    expect(answer?.retrievalConfidence?.score).toBe(0)
    expect(provider.embed).not.toHaveBeenCalled()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
