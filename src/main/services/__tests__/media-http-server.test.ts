import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRecordingMediaHttpServer, stopRecordingMediaHttpServer } from '../media-http-server'

vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  getDecryptedTempPathForMedia: vi.fn(),
  clearMediaDecryptCache: vi.fn(),
  isCurrentBuildDecryptedTempFileName: vi.fn().mockReturnValue(false)
}))
vi.mock('../autodoc-log', () => ({ logAutodocFailure: vi.fn() }))

const meetingId = '11111111-1111-4111-8111-111111111111'
let root: string
let base: string

describe('recording media download responses', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'autodoc-media-download-test-'))
    await mkdir(join(root, meetingId))
    await writeFile(join(root, meetingId, 'screen.webm'), 'synthetic-media-bytes')
    const port = await startRecordingMediaHttpServer(() => root)
    base = `http://127.0.0.1:${port}/media/${meetingId}/screen.webm`
  })
  afterAll(async () => {
    stopRecordingMediaHttpServer()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('preserves inline playback and only opts into attachment downloads explicitly', async () => {
    const inline = await fetch(base)
    expect(inline.status).toBe(200)
    expect(inline.headers.get('content-disposition')).toBeNull()
    expect(await inline.text()).toBe('synthetic-media-bytes')
    const download = await fetch(base + '?download=1')
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="screen.webm"')
    expect(await download.text()).toBe('synthetic-media-bytes')
  })

  it('retains byte-range playback and validates the same file paths for downloads', async () => {
    const partial = await fetch(base + '?download=1', { headers: { Range: 'bytes=2-5' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-disposition')).toBe('attachment; filename="screen.webm"')
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/21')
    expect(await partial.text()).toBe('nthe')
    const invalid = await fetch(base.replace(meetingId, 'not-a-meeting') + '?download=1')
    expect(invalid.status).toBe(404)
    expect(invalid.headers.get('content-disposition')).toBeNull()
  })
})
