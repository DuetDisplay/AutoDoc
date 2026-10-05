import { app } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { getMeetingAsrRoute, type MeetingAsrRoute } from '../../shared/meeting-language'

export interface MacSpeechModel {
  repo: string
  revision: string
  files: readonly { name: string; bytes: number; sha256: string }[]
}

// Hugging Face metadata at these revisions; weight hashes are the LFS SHA-256.
// Small config hashes were computed from the pinned files on 2026-10-05.
export const MAC_SPEECH_MODELS = {
  canary: {
    repo: 'Mediform/canary-1b-v2-mlx-q8',
    revision: '0b6b32ee10f30c89e3ead7249bb636445e3019ee',
    files: [
      {
        name: 'config.json',
        bytes: 673039,
        sha256: 'fdecfe775789a06d2e2860de7f73dbb311b6f78f7694d1e2dff712aca36b56a5'
      },
      {
        name: 'model.safetensors',
        bytes: 1136436574,
        sha256: 'f637b904eeb83d4327158b3df0a687e8ba8cdde2cde1576127f696dc36a84ba5'
      }
    ]
  },
  'whisper-turbo': {
    repo: 'mlx-community/whisper-large-v3-turbo',
    revision: 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb',
    files: [
      {
        name: 'config.json',
        bytes: 268,
        sha256: 'b34fc29e4e11e0a25e812775dd67f4dd16fc2c8eb43d28ae25ff7d660ecb6379'
      },
      {
        name: 'weights.safetensors',
        bytes: 1613977612,
        sha256: '951ed3fc1203e6a62467abb2144a96ce7eafca8fa77e3704fdb8635ff3e7f8a6'
      }
    ]
  },
  vad: {
    repo: 'istupakov/silero-vad-onnx',
    revision: 'b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6',
    files: [
      {
        name: 'config.json',
        bytes: 30,
        sha256: '1094039d370c82889582ba739a3d1caac5754c8b3a17a66a534200c9f72086e2'
      },
      {
        name: 'silero_vad.onnx',
        bytes: 2327524,
        sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'
      }
    ]
  }
} satisfies Record<Exclude<MeetingAsrRoute, 'english'> | 'vad', MacSpeechModel>

export function macSpeechModelCacheDir(route: Exclude<MeetingAsrRoute, 'english'>): string {
  const override =
    route === 'canary'
      ? process.env.AUTODOC_MAC_CANARY_CACHE_DIR
      : process.env.AUTODOC_MLX_WHISPER_TURBO_CACHE_DIR
  return (
    override?.trim() ||
    join(
      app.getPath('userData'),
      'models',
      route === 'canary' ? 'canary-mlx-cache' : 'mlx-whisper-turbo-cache'
    )
  )
}

export function macSpeechModelPath(model: MacSpeechModel, cacheDir: string): string {
  return join(
    cacheDir,
    'hub',
    `models--${model.repo.replaceAll('/', '--')}`,
    'snapshots',
    model.revision
  )
}

function routeModels(language: unknown): readonly MacSpeechModel[] {
  const route = getMeetingAsrRoute(language)
  return route === 'english'
    ? []
    : route === 'canary'
      ? [MAC_SPEECH_MODELS.canary, MAC_SPEECH_MODELS.vad]
      : [MAC_SPEECH_MODELS['whisper-turbo']]
}

type VerifiedFiles = Record<string, { bytes: number; mtimeMs: number; sha256: string }>
const VERIFIED_MARKER = 'AUTODOC_VERIFIED.json'

async function verifiedFiles(model: MacSpeechModel, cacheDir: string): Promise<VerifiedFiles> {
  try {
    const parsed = JSON.parse(
      await readFile(join(macSpeechModelPath(model, cacheDir), VERIFIED_MARKER), 'utf8')
    )
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function fileIsVerified(
  model: MacSpeechModel,
  cacheDir: string,
  file: MacSpeechModel['files'][number],
  verified: VerifiedFiles
): Promise<boolean> {
  try {
    const info = await stat(join(macSpeechModelPath(model, cacheDir), file.name))
    const stamp = verified[file.name]
    return (
      info.isFile() &&
      info.size === file.bytes &&
      stamp?.bytes === info.size &&
      stamp?.mtimeMs === info.mtimeMs &&
      stamp?.sha256 === file.sha256
    )
  } catch {
    return false
  }
}

/** Stats, not gigabyte hash reads, on the picker and recording paths. */
export async function getMacRouteFirstUseDownloadBytes(language: unknown): Promise<number> {
  const route = getMeetingAsrRoute(language)
  if (route === 'english') return 0
  const cacheDir = macSpeechModelCacheDir(route)
  let bytes = 0
  for (const model of routeModels(language)) {
    const verified = await verifiedFiles(model, cacheDir)
    for (const file of model.files) {
      if (!(await fileIsVerified(model, cacheDir, file, verified))) bytes += file.bytes
    }
  }
  return bytes
}

export type MacSpeechModelDownloader = (
  url: string,
  path: string,
  sha256: string,
  progress: (percent: number) => void
) => Promise<void>

/** Download only during setup/selection; the bridges receive these local paths. */
export async function downloadMacSpeechModels(
  language: unknown,
  download: MacSpeechModelDownloader,
  onProgress: (percent: number) => void
): Promise<void> {
  const route = getMeetingAsrRoute(language)
  if (route === 'english') return
  const cacheDir = macSpeechModelCacheDir(route)
  const total = await getMacRouteFirstUseDownloadBytes(language)
  let completed = 0
  for (const model of routeModels(language)) {
    const root = macSpeechModelPath(model, cacheDir)
    await mkdir(root, { recursive: true })
    const verified = await verifiedFiles(model, cacheDir)
    for (const file of model.files) {
      if (await fileIsVerified(model, cacheDir, file, verified)) continue
      await download(
        `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.name}`,
        join(root, file.name),
        file.sha256,
        (percent) =>
          onProgress(
            total > 0
              ? Math.min(99, Math.floor(((completed + (file.bytes * percent) / 100) / total) * 100))
              : 100
          )
      )
      const info = await stat(join(root, file.name))
      if (info.size !== file.bytes)
        throw new Error(
          `Speech model ${file.name} has an unexpected size: ${info.size}, expected ${file.bytes}.`
        )
      verified[file.name] = { bytes: info.size, mtimeMs: info.mtimeMs, sha256: file.sha256 }
      await writeFile(join(root, VERIFIED_MARKER), JSON.stringify(verified))
      completed += file.bytes
    }
  }
  onProgress(100)
}
