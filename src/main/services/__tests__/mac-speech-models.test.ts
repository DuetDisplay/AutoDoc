import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import {
  MAC_SPEECH_MODELS,
  downloadMacSpeechModels,
  getMacRouteFirstUseDownloadBytes,
  macSpeechModelPath,
  type MacSpeechModelDownloader
} from '../mac-speech-models'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
const original = structuredClone(MAC_SPEECH_MODELS)
let cache: string
const contents = Buffer.from('model-fixture')
const sha = createHash('sha256').update(contents).digest('hex')
beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), 'ad100-models-'))
  vi.stubEnv('AUTODOC_MAC_CANARY_CACHE_DIR', cache)
  vi.stubEnv('AUTODOC_MLX_WHISPER_TURBO_CACHE_DIR', cache)
  for (const model of Object.values(MAC_SPEECH_MODELS)) {
    for (const file of model.files) {
      file.bytes = contents.length
      file.sha256 = sha
    }
  }
})
afterEach(async () => {
  Object.assign(MAC_SPEECH_MODELS, structuredClone(original))
  vi.unstubAllEnvs()
  await rm(cache, { recursive: true, force: true })
})

const download = vi.fn<MacSpeechModelDownloader>(async (_url, path, expected, progress) => {
  expect(expected).toBe(sha)
  await writeFile(path, contents)
  progress(50)
  progress(100)
})

describe('Mac first-use model files', () => {
  beforeEach(() => {
    download.mockClear()
  })
  it.each(['fr', 'es'] as const)(
    'downloads pinned %s route files, reports progress, and reuses verified files',
    async (language) => {
      const expectedFiles = language === 'fr' ? 4 : 2
      expect(await getMacRouteFirstUseDownloadBytes(language)).toBe(contents.length * expectedFiles)
      const progress = vi.fn()
      await downloadMacSpeechModels(language, download, progress)
      expect(download).toHaveBeenCalledTimes(expectedFiles)
      const urls = download.mock.calls.map(([url]) => url)
      const model = MAC_SPEECH_MODELS[language === 'fr' ? 'canary' : 'whisper-turbo']
      expect(urls).toContain(
        `https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.files[0].name}`
      )
      expect(urls.every((url) => !url.includes('/main/'))).toBe(true)
      expect(progress.mock.calls.at(-1)).toEqual([100])
      expect(progress.mock.calls.map(([percent]) => percent)).toEqual(
        [...progress.mock.calls.map(([percent]) => percent)].sort((a, b) => a - b)
      )
      expect(await getMacRouteFirstUseDownloadBytes(language)).toBe(0)
      await downloadMacSpeechModels(language, download, progress)
      expect(download).toHaveBeenCalledTimes(expectedFiles)
    }
  )
  it('never downloads the English model through this path', async () => {
    await downloadMacSpeechModels('en', download, vi.fn())
    expect(download).not.toHaveBeenCalled()
  })
  it('keeps completed files for retry after an offline failure', async () => {
    download.mockImplementationOnce(async (_url, path, _sha, progress) => {
      await writeFile(path, contents)
      progress(100)
    })
    download.mockRejectedValueOnce(new Error('offline'))
    await expect(downloadMacSpeechModels('es', download, vi.fn())).rejects.toThrow('offline')
    expect(await getMacRouteFirstUseDownloadBytes('es')).toBe(contents.length)
    await downloadMacSpeechModels('es', download, vi.fn())
    expect(await getMacRouteFirstUseDownloadBytes('es')).toBe(0)
  })
  it('rejects incomplete files without marking them verified', async () => {
    download.mockImplementationOnce(async (_url, path) => {
      await writeFile(path, 'short')
    })
    await expect(downloadMacSpeechModels('es', download, vi.fn())).rejects.toThrow(
      'unexpected size'
    )
    expect(await getMacRouteFirstUseDownloadBytes('es')).toBe(contents.length * 2)
  })
  it('detects modified files even when their length is unchanged', async () => {
    await downloadMacSpeechModels('es', download, vi.fn())
    const path = join(
      macSpeechModelPath(MAC_SPEECH_MODELS['whisper-turbo'], cache),
      'weights.safetensors'
    )
    const info = await stat(path)
    await writeFile(path, Buffer.alloc(contents.length))
    const { utimes } = await import('fs/promises')
    await utimes(path, info.atime, new Date(info.mtimeMs + 1000))
    expect(await getMacRouteFirstUseDownloadBytes('es')).toBe(contents.length)
    expect(await readFile(path)).not.toEqual(contents)
  })
})
