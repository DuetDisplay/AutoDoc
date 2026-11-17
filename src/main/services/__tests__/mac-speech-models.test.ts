import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import {
  MAC_SPEECH_MODELS,
  downloadMacEnglishModel,
  downloadMacSpeechModels,
  getMacRouteFirstUseDownloadBytes,
  macEnglishModelPath,
  macSpeechModelPath,
  macSpeechModelSources,
  type MacSpeechModelDownloader
} from '../mac-speech-models'

const { userData } = vi.hoisted(() => ({ userData: { path: '/unused' } }))
vi.mock('electron', () => ({ app: { getPath: () => userData.path } }))
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
      const urls = download.mock.calls.map(([sources]) => sources[0])
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
  it('offers ModelScope at its own commit, then hf-mirror, for the Chinese and English models', () => {
    const { repo, revision } = MAC_SPEECH_MODELS['whisper-turbo']
    expect(
      macSpeechModelSources(MAC_SPEECH_MODELS['whisper-turbo'], 'weights.safetensors')
    ).toEqual([
      `https://huggingface.co/${repo}/resolve/${revision}/weights.safetensors`,
      `https://modelscope.cn/models/${repo}/resolve/2ea465385494dbe25b7d5a2ec15f2c4fdfe3e33b/weights.safetensors`,
      `https://hf-mirror.com/${repo}/resolve/${revision}/weights.safetensors`
    ])
    const english = MAC_SPEECH_MODELS.english
    expect(macSpeechModelSources(english, 'weights.npz')[1]).toBe(
      `https://modelscope.cn/models/${english.repo}/resolve/439c133f8a15e22a8b0745d332c54e990cffa196/weights.npz`
    )
  })
  it('offers only hf-mirror for models that ModelScope does not have', () => {
    const { repo, revision } = MAC_SPEECH_MODELS.canary
    expect(macSpeechModelSources(MAC_SPEECH_MODELS.canary, 'model.safetensors')).toEqual([
      `https://huggingface.co/${repo}/resolve/${revision}/model.safetensors`,
      `https://hf-mirror.com/${repo}/resolve/${revision}/model.safetensors`
    ])
  })
  it('tries every source for each file of a route', async () => {
    await downloadMacSpeechModels('es', download, vi.fn())
    for (const [sources] of download.mock.calls) expect(sources).toHaveLength(3)
  })
  describe('English model', () => {
    beforeEach(() => {
      userData.path = cache
    })
    it('downloads pinned files into the existing cache and reuses them', async () => {
      const progress = vi.fn()
      await downloadMacEnglishModel(download, progress)

      expect(download).toHaveBeenCalledTimes(2)
      const root = macEnglishModelPath()
      expect(root).toBe(
        join(
          cache,
          'models',
          'mlx-whisper-cache',
          'hub',
          'models--mlx-community--distil-whisper-large-v3',
          'snapshots',
          MAC_SPEECH_MODELS.english.revision
        )
      )
      expect(await readFile(join(root, 'weights.npz'))).toEqual(contents)
      expect(progress.mock.calls.at(-1)).toEqual([100])

      download.mockClear()
      await downloadMacEnglishModel(download, vi.fn())
      expect(download).not.toHaveBeenCalled()
    })
    it('marks a file the downloader verified from an earlier cache as ready', async () => {
      const root = macEnglishModelPath()
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'weights.npz'), contents)
      await writeFile(join(root, 'config.json'), contents)
      // The real downloader hashes a file already on disk instead of fetching it.
      const reuse = vi.fn<MacSpeechModelDownloader>(async () => {})

      await downloadMacEnglishModel(reuse, vi.fn())
      expect(reuse).toHaveBeenCalledTimes(2)

      reuse.mockClear()
      await downloadMacEnglishModel(reuse, vi.fn())
      expect(reuse).not.toHaveBeenCalled()
    })
    it('does not count toward the first-use size of the route picker', async () => {
      expect(await getMacRouteFirstUseDownloadBytes('en')).toBe(0)
    })
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
