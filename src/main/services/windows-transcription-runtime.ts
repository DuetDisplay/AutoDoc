import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { cpus } from 'os'
import { promisify } from 'util'
import { getConfiguredWindowsTranscriptionAssetBaseUrl } from './distribution-config'

const execFileAsync = promisify(execFile)

export type WindowsTranscriptionBackendId =
  | 'faster-whisper-cuda'
  | 'faster-whisper-cpu'
  | 'whisper-cpp'

export type WindowsGpuVendor = 'nvidia' | 'intel' | 'amd' | 'unknown'

export interface WindowsGpuInfo {
  name: string
  vendor: WindowsGpuVendor
  adapterRamGiB: number | null
}

export interface WindowsHardwareProfile {
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  logicalProcessors: number
  freeMemoryGiB: number | null
  totalMemoryGiB: number | null
  gpus: WindowsGpuInfo[]
}

export interface WindowsTranscriptionAsset {
  id: 'runtime' | 'model'
  filename: string
  url: string
  sha256: string
  bytes?: number
  expectedFiles: string[]
  sources?: string[]
  licenses?: string[]
}

export interface WindowsTranscriptionProfile {
  id: WindowsTranscriptionBackendId
  label: string
  modelName: string
  device: 'cuda' | 'cpu'
  computeType: 'float16' | 'int8'
  minSystemMemoryGiB: number
  minVramGiB?: number
  assets: WindowsTranscriptionAsset[]
}

export interface WindowsTranscriptionManifest {
  version: number
  releaseTag: string
  artifactBaseUrl?: string
  profiles: WindowsTranscriptionProfile[]
}

const ASSET_BASE_URL = getConfiguredWindowsTranscriptionAssetBaseUrl()

export const WINDOWS_TRANSCRIPTION_PROFILES: Record<
  WindowsTranscriptionBackendId,
  WindowsTranscriptionProfile
> = {
  'faster-whisper-cuda': {
    id: 'faster-whisper-cuda',
    label: 'NVIDIA accelerated transcription',
    modelName: 'distil-large-v3',
    device: 'cuda',
    computeType: 'float16',
    minSystemMemoryGiB: 12,
    minVramGiB: 6,
    assets: [
      {
        id: 'runtime',
        filename: 'faster-whisper-runtime-cuda-win-x64.zip',
        url: ASSET_BASE_URL ? `${ASSET_BASE_URL}/faster-whisper-runtime-cuda-win-x64.zip` : '',
        sha256: '785d572be18d058882fd3256b8aec4bd249ddf77f3f392659372ddf08c85bf1a',
        bytes: 1439431425,
        expectedFiles: [
          'python.exe',
          'Lib/site-packages/faster_whisper',
          'Lib/site-packages/ctranslate2'
        ]
      },
      {
        id: 'model',
        filename: 'faster-whisper-distil-large-v3-ct2.zip',
        url: ASSET_BASE_URL ? `${ASSET_BASE_URL}/faster-whisper-distil-large-v3-ct2.zip` : '',
        sha256: '81ae0a2cc4dfe70370cb33129c191365e0c090dddb4924b077ee0ffad42b5064',
        bytes: 1397218990,
        expectedFiles: ['config.json', 'model.bin', 'tokenizer.json']
      }
    ]
  },
  'faster-whisper-cpu': {
    id: 'faster-whisper-cpu',
    label: 'CPU optimized transcription',
    modelName: 'small.en',
    device: 'cpu',
    computeType: 'int8',
    minSystemMemoryGiB: 8,
    assets: [
      {
        id: 'runtime',
        filename: 'faster-whisper-runtime-cpu-win-x64.zip',
        url: ASSET_BASE_URL ? `${ASSET_BASE_URL}/faster-whisper-runtime-cpu-win-x64.zip` : '',
        sha256: '63cc6240161372f9f45c2b218664a5cf3f7349530a7bdd9ed129849a90ff2ca9',
        bytes: 122910760,
        expectedFiles: [
          'python.exe',
          'Lib/site-packages/faster_whisper',
          'Lib/site-packages/ctranslate2'
        ]
      },
      {
        id: 'model',
        filename: 'faster-whisper-small-en-ct2-int8.zip',
        url: ASSET_BASE_URL ? `${ASSET_BASE_URL}/faster-whisper-small-en-ct2-int8.zip` : '',
        sha256: '1347c7e02d8d70be7d5c7ed88729c29c9abc716f39322d62d6342b9a741bcaa8',
        bytes: 445198952,
        expectedFiles: ['config.json', 'model.bin', 'tokenizer.json']
      }
    ]
  },
  'whisper-cpp': {
    id: 'whisper-cpp',
    label: 'compatible transcription',
    modelName: 'distil-large-v3-ggml',
    device: 'cpu',
    computeType: 'int8',
    minSystemMemoryGiB: 8,
    assets: []
  }
}

export async function loadWindowsTranscriptionProfiles(
  manifestPath: string
): Promise<Record<WindowsTranscriptionBackendId, WindowsTranscriptionProfile>> {
  try {
    const raw = await readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(raw) as WindowsTranscriptionManifest
    return normalizeWindowsTranscriptionProfiles(manifest)
  } catch {
    return WINDOWS_TRANSCRIPTION_PROFILES
  }
}

export function normalizeWindowsTranscriptionProfiles(
  manifest: WindowsTranscriptionManifest
): Record<WindowsTranscriptionBackendId, WindowsTranscriptionProfile> {
  const profiles = { ...WINDOWS_TRANSCRIPTION_PROFILES }
  const artifactBaseUrl =
    getConfiguredWindowsTranscriptionAssetBaseUrl() ?? manifest.artifactBaseUrl ?? null

  for (const profile of manifest.profiles) {
    if (
      profile.id !== 'faster-whisper-cuda' &&
      profile.id !== 'faster-whisper-cpu' &&
      profile.id !== 'whisper-cpp'
    ) {
      continue
    }

    profiles[profile.id] = {
      ...profile,
      assets: profile.assets.map((asset) => ({
        ...asset,
        url: artifactBaseUrl ? `${artifactBaseUrl.replace(/\/$/, '')}/${asset.filename}` : asset.url
      }))
    }
  }

  return profiles
}

export function classifyWindowsGpuVendor(name: string): WindowsGpuVendor {
  const normalized = name.toLowerCase()
  if (
    normalized.includes('nvidia') ||
    normalized.includes('geforce') ||
    normalized.includes('rtx')
  ) {
    return 'nvidia'
  }
  if (normalized.includes('intel')) {
    return 'intel'
  }
  if (
    normalized.includes('amd') ||
    normalized.includes('radeon') ||
    normalized.includes('advanced micro devices')
  ) {
    return 'amd'
  }
  return 'unknown'
}

export function selectWindowsTranscriptionProfile(
  hardware: WindowsHardwareProfile,
  profiles: Record<
    WindowsTranscriptionBackendId,
    WindowsTranscriptionProfile
  > = WINDOWS_TRANSCRIPTION_PROFILES
): WindowsTranscriptionProfile {
  const forced = normalizeForcedBackend(process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND)
  if (forced) {
    return profiles[forced]
  }

  if (hardware.platform !== 'win32' || hardware.arch !== 'x64') {
    return profiles['whisper-cpp']
  }

  const totalMemoryGiB = hardware.totalMemoryGiB ?? Number.POSITIVE_INFINITY
  const nvidiaGpu = hardware.gpus.find((gpu) => gpu.vendor === 'nvidia')
  const cudaProfile = profiles['faster-whisper-cuda']
  if (
    nvidiaGpu &&
    totalMemoryGiB >= cudaProfile.minSystemMemoryGiB &&
    (nvidiaGpu.adapterRamGiB == null ||
      cudaProfile.minVramGiB == null ||
      nvidiaGpu.adapterRamGiB >= cudaProfile.minVramGiB)
  ) {
    return cudaProfile
  }

  return profiles['faster-whisper-cpu']
}

export async function detectWindowsHardwareProfile(): Promise<WindowsHardwareProfile> {
  return {
    platform: process.platform,
    arch: process.arch,
    logicalProcessors: cpus().length,
    ...getSystemMemorySnapshot(),
    gpus: process.platform === 'win32' ? await queryWindowsGpus() : []
  }
}

function normalizeForcedBackend(value: string | undefined): WindowsTranscriptionBackendId | null {
  if (!value || value === 'auto') {
    return null
  }

  if (
    value === 'faster-whisper-cuda' ||
    value === 'faster-whisper-cpu' ||
    value === 'whisper-cpp'
  ) {
    return value
  }

  return null
}

function getSystemMemorySnapshot(): Pick<
  WindowsHardwareProfile,
  'freeMemoryGiB' | 'totalMemoryGiB'
> {
  const processWithMemory = process as NodeJS.Process & {
    getSystemMemoryInfo?: () => { free?: number; total?: number }
  }
  const info = processWithMemory.getSystemMemoryInfo?.()
  if (!info) {
    return { freeMemoryGiB: null, totalMemoryGiB: null }
  }

  return {
    freeMemoryGiB: typeof info.free === 'number' ? bytesToGiB(info.free) : null,
    totalMemoryGiB: typeof info.total === 'number' ? bytesToGiB(info.total) : null
  }
}

async function queryWindowsGpus(): Promise<WindowsGpuInfo[]> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'
    ])
    const parsed = JSON.parse(stdout.trim()) as unknown
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    return rows
      .map((row) => parseWindowsGpuRow(row))
      .filter((gpu): gpu is WindowsGpuInfo => gpu !== null)
  } catch {
    return []
  }
}

function parseWindowsGpuRow(row: unknown): WindowsGpuInfo | null {
  if (!row || typeof row !== 'object') {
    return null
  }

  const record = row as { Name?: unknown; AdapterRAM?: unknown }
  if (typeof record.Name !== 'string' || record.Name.trim() === '') {
    return null
  }

  const adapterRamBytes =
    typeof record.AdapterRAM === 'number' && Number.isFinite(record.AdapterRAM)
      ? record.AdapterRAM
      : null

  return {
    name: record.Name,
    vendor: classifyWindowsGpuVendor(record.Name),
    adapterRamGiB:
      adapterRamBytes != null && adapterRamBytes > 0 ? bytesToGiB(adapterRamBytes) : null
  }
}

function bytesToGiB(bytes: number): number {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2))
}
