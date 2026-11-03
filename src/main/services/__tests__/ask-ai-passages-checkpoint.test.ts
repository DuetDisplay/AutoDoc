import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { expect, it, vi } from 'vitest'
import { AskAiPassages } from '../ask-ai-passages'
import type { IndexedMeeting } from '../meeting-index'
import { logAutodocEvent } from '../autodoc-log'
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
// This unit codec uses only generated data. Real-app checks verify ADOC encryption.
vi.mock('../crypto', () => ({
  encryptJSON: (value: unknown, file: string) => writeFile(file, JSON.stringify(value)),
  decryptJSON: async (file: string) => JSON.parse(await readFile(file, 'utf8'))
}))
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
it('checkpoints periodically and on pause, then restores the persisted vectors without embedding again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autodoc-index-checkpoint-'))
  try {
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
    const file = join(dir, 'index.enc'),
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
    expect(await readdir(dir)).toEqual(['index.enc'])
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
