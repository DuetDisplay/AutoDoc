import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { availableParallelism, cpus } from 'os'
import { promisify } from 'util'
import { getConfiguredWindowsTranscriptionAssetBaseUrl } from './distribution-config'

const execFileAsync = promisify(execFile)

export type WindowsTranscriptionBackendId =
  | 'faster-whisper-cuda'
  | 'faster-whisper-cpu'
  | 'parakeet-gpu'
  | 'parakeet-cpu'
  | 'whisper-cpp'

export type WindowsTranscriptionEngine = 'faster-whisper' | 'parakeet' | 'whisper-cpp'

export type WindowsGpuVendor = 'nvidia' | 'intel' | 'amd' | 'unknown'

export interface WindowsGpuInfo {
  name: string
  vendor: WindowsGpuVendor
  adapterRamGiB: number | null
}

export interface NvidiaSmiGpuInfo {
  name: string
  memoryTotalMiB: number | null
  driverVersion: string | null
}

export interface WindowsRegistryGpuRow {
  Description?: string
  AdapterString?: string
  DriverDesc?: string
  qwMemorySize?: number | string | null
}

export interface WindowsRegistryGpuEntry {
  name: string
  vramGiB: number | null
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
  engine: WindowsTranscriptionEngine
  device: 'cuda' | 'cpu' | 'dml'
  computeType: 'float16' | 'int8_float16' | 'int8_float32' | 'int8' | 'fp32'
  minSystemMemoryGiB: number
  estimatedMemoryGiB: number
  minVramGiB?: number
  assets: WindowsTranscriptionAsset[]
}

export const WINDOWS_CONCURRENT_LOCAL_PROCESSING_MIN_LOGICAL_PROCESSORS = 12
export const WINDOWS_CONCURRENT_LOCAL_PROCESSING_MIN_FREE_MEMORY_GIB = 6

const KNOWN_WINDOWS_TRANSCRIPTION_PROFILE_IDS: WindowsTranscriptionBackendId[] = [
  'faster-whisper-cuda',
  'faster-whisper-cpu',
  'parakeet-gpu',
  'parakeet-cpu',
  'whisper-cpp'
]

export function shouldSerializeWindowsLocalProcessing(
  logicalProcessors: number,
  freeMemoryGiB: number | null
): boolean {
  if (logicalProcessors < WINDOWS_CONCURRENT_LOCAL_PROCESSING_MIN_LOGICAL_PROCESSORS) {
    return true
  }

  if (
    freeMemoryGiB != null &&
    freeMemoryGiB < WINDOWS_CONCURRENT_LOCAL_PROCESSING_MIN_FREE_MEMORY_GIB
  ) {
    return true
  }

  return false
}

export interface WindowsTranscriptionManifest {
  version: number
  releaseTag: string
  artifactBaseUrl?: string
  profiles: Array<
    Partial<WindowsTranscriptionProfile> & {
      id: WindowsTranscriptionBackendId
    }
  >
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
    engine: 'faster-whisper',
    device: 'cuda',
    computeType: 'int8_float32',
    minSystemMemoryGiB: 12,
    estimatedMemoryGiB: 3.5,
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
    engine: 'faster-whisper',
    device: 'cpu',
    computeType: 'int8',
    minSystemMemoryGiB: 8,
    estimatedMemoryGiB: 1.5,
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
  'parakeet-gpu': {
    id: 'parakeet-gpu',
    label: 'GPU accelerated transcription',
    modelName: 'parakeet-tdt-0.6b-v3',
    engine: 'parakeet',
    device: 'dml',
    computeType: 'fp32',
    minSystemMemoryGiB: 8,
    estimatedMemoryGiB: 4,
    minVramGiB: 4,
    assets: [
      {
        id: 'runtime',
        filename: 'parakeet-runtime-win-x64.zip',
        url: ASSET_BASE_URL ? `${ASSET_BASE_URL}/parakeet-runtime-win-x64.zip` : '',
        sha256: '',
        expectedFiles: ['python.exe', 'Lib/site-packages/onnx_asr', 'Lib/site-packages/onnxruntime']
      },
      {
        id: 'model',
        filename: 'parakeet-tdt-0.6b-v3-fp32.zip',
        url: ASSET_BASE_URL ? `${ASSET_BASE_URL}/parakeet-tdt-0.6b-v3-fp32.zip` : '',
        sha256: '',
        expectedFiles: [
          'encoder-model.onnx',
          'encoder-model.onnx.data',
          'decoder_joint-model.onnx',
          'vocab.txt',
          'config.json',
          'nemo128.onnx',
          'silero_vad.onnx'
        ]
      }
    ]
  },
  'parakeet-cpu': {
    id: 'parakeet-cpu',
    label: 'CPU optimized transcription',
    modelName: 'parakeet-tdt-0.6b-v3',
    engine: 'parakeet',
    device: 'cpu',
    computeType: 'int8',
    minSystemMemoryGiB: 8,
    estimatedMemoryGiB: 2,
    assets: [
      {
        id: 'runtime',
        filename: 'parakeet-runtime-win-x64.zip',
        url: ASSET_BASE_URL ? `${ASSET_BASE_URL}/parakeet-runtime-win-x64.zip` : '',
        sha256: '',
        expectedFiles: ['python.exe', 'Lib/site-packages/onnx_asr', 'Lib/site-packages/onnxruntime']
      },
      {
        id: 'model',
        filename: 'parakeet-tdt-0.6b-v3-int8.zip',
        url: ASSET_BASE_URL ? `${ASSET_BASE_URL}/parakeet-tdt-0.6b-v3-int8.zip` : '',
        sha256: '',
        expectedFiles: [
          'encoder-model.int8.onnx',
          'decoder_joint-model.int8.onnx',
          'vocab.txt',
          'config.json',
          'nemo128.onnx',
          'silero_vad.onnx'
        ]
      }
    ]
  },
  'whisper-cpp': {
    id: 'whisper-cpp',
    label: 'compatible transcription',
    modelName: 'base.en',
    engine: 'whisper-cpp',
    device: 'cpu',
    computeType: 'int8',
    minSystemMemoryGiB: 8,
    estimatedMemoryGiB: 2.5,
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
    if (!KNOWN_WINDOWS_TRANSCRIPTION_PROFILE_IDS.includes(profile.id)) {
      continue
    }

    const defaults = WINDOWS_TRANSCRIPTION_PROFILES[profile.id]
    profiles[profile.id] = {
      ...defaults,
      ...profile,
      engine: profile.engine ?? defaults.engine,
      estimatedMemoryGiB: profile.estimatedMemoryGiB ?? defaults.estimatedMemoryGiB,
      assets: (profile.assets ?? defaults.assets).map((asset, index) => ({
        ...(defaults.assets[index] ?? asset),
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

export function parseWindowsRegistryGpuRows(rows: unknown[]): WindowsRegistryGpuEntry[] {
  return rows
    .map((row) => parseWindowsRegistryGpuRow(row))
    .filter((entry): entry is WindowsRegistryGpuEntry => entry !== null)
}

function parseWindowsRegistryGpuRow(row: unknown): WindowsRegistryGpuEntry | null {
  if (!row || typeof row !== 'object') {
    return null
  }

  const record = row as WindowsRegistryGpuRow
  const nameCandidate =
    typeof record.AdapterString === 'string' && record.AdapterString.trim()
      ? record.AdapterString
      : typeof record.DriverDesc === 'string' && record.DriverDesc.trim()
        ? record.DriverDesc
        : typeof record.Description === 'string' && record.Description.trim()
          ? record.Description
          : null

  if (!nameCandidate) {
    return null
  }

  return {
    name: nameCandidate,
    vramGiB: parseRegistryMemorySizeGiB(record.qwMemorySize)
  }
}

function parseRegistryMemorySizeGiB(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return bytesToGiB(value)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    const parsed = Number.parseInt(trimmed, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return bytesToGiB(parsed)
    }
  }

  return null
}

export function applyRegistryGpuMemory(
  gpus: WindowsGpuInfo[],
  registryEntries: WindowsRegistryGpuEntry[]
): WindowsGpuInfo[] {
  if (registryEntries.length === 0) {
    return gpus
  }

  const next = [...gpus]
  const usedIndexes = new Set<number>()

  for (const registryGpu of registryEntries) {
    const normalizedRegistryName = normalizeGpuName(registryGpu.name)
    const matchIndex = next.findIndex(
      (gpu, index) =>
        !usedIndexes.has(index) &&
        namesLikelyReferToSameGpu(normalizeGpuName(gpu.name), normalizedRegistryName)
    )

    if (matchIndex >= 0) {
      usedIndexes.add(matchIndex)
      next[matchIndex] = {
        ...next[matchIndex],
        adapterRamGiB: registryGpu.vramGiB ?? next[matchIndex].adapterRamGiB
      }
      continue
    }

    next.push({
      name: registryGpu.name,
      vendor: classifyWindowsGpuVendor(registryGpu.name),
      adapterRamGiB: registryGpu.vramGiB
    })
    usedIndexes.add(next.length - 1)
  }

  return next
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

  const totalMemoryGiB = hardware.totalMemoryGiB ?? 0
  const eligibleGpus = hardware.gpus.filter((gpu) => gpu.vendor !== 'unknown')
  const gpuProfile = profiles['parakeet-gpu']
  const hasEligibleGpu = eligibleGpus.some(
    (gpu) =>
      gpu.adapterRamGiB != null &&
      gpuProfile.minVramGiB != null &&
      gpu.adapterRamGiB >= gpuProfile.minVramGiB
  )
  const hasUnknownVramWithEnoughRam = eligibleGpus.some(
    (gpu) => gpu.adapterRamGiB == null && totalMemoryGiB >= 16
  )

  if (hasEligibleGpu || hasUnknownVramWithEnoughRam) {
    return gpuProfile
  }

  return profiles['parakeet-cpu']
}

export async function detectWindowsHardwareProfile(): Promise<WindowsHardwareProfile> {
  return {
    platform: process.platform,
    arch: process.arch,
    logicalProcessors: getUsableLogicalProcessorCount(),
    ...getSystemMemorySnapshot(),
    gpus: process.platform === 'win32' ? await queryWindowsGpus() : []
  }
}

/**
 * availableParallelism respects the process affinity mask, so profile
 * selection sees the processors actually usable by this process (and its
 * children) rather than the machine's raw core count. This also matches how
 * getWhisperThreadCount counts processors.
 *
 * AUTODOC_TEST_LOGICAL_PROCESSORS exists for QA staging (e.g. exercising the
 * win-low-spec profile on a high-core dev machine where launch-time affinity
 * is blocked by the harness job object).
 */
export function getUsableLogicalProcessorCount(): number {
  const override = Number.parseInt(process.env.AUTODOC_TEST_LOGICAL_PROCESSORS ?? '', 10)
  if (Number.isFinite(override) && override > 0) {
    return override
  }

  try {
    if (typeof availableParallelism === 'function') {
      return Math.max(1, availableParallelism())
    }
  } catch {
    // Fall through to the raw cpu count.
  }

  return Math.max(1, cpus().length)
}

function normalizeForcedBackend(value: string | undefined): WindowsTranscriptionBackendId | null {
  if (!value || value === 'auto') {
    return null
  }

  if (
    value === 'faster-whisper-cuda' ||
    value === 'faster-whisper-cpu' ||
    value === 'parakeet-gpu' ||
    value === 'parakeet-cpu' ||
    value === 'whisper-cpp'
  ) {
    return value
  }

  return null
}

export function getSystemMemorySnapshot(): Pick<
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
    freeMemoryGiB: typeof info.free === 'number' ? electronMemoryKbToGiB(info.free) : null,
    totalMemoryGiB: typeof info.total === 'number' ? electronMemoryKbToGiB(info.total) : null
  }
}

async function queryWindowsGpus(): Promise<WindowsGpuInfo[]> {
  let gpus: WindowsGpuInfo[] = []

  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'
    ])
    const parsed = JSON.parse(stdout.trim()) as unknown
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    gpus = rows
      .map((row) => parseWindowsGpuRow(row))
      .filter((gpu): gpu is WindowsGpuInfo => gpu !== null)
  } catch {
    gpus = []
  }

  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `$base='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'; Get-ChildItem "$base\\0*" | ForEach-Object { Get-ItemProperty $_.PSPath | Select-Object Description,DriverDesc,@{Name='AdapterString';Expression={$_.'HardwareInformation.AdapterString'}},@{Name='qwMemorySize';Expression={$_.'HardwareInformation.qwMemorySize'}} } | ConvertTo-Json -Compress`
    ])
    const parsed = JSON.parse(stdout.trim() || '[]') as unknown
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    gpus = applyRegistryGpuMemory(gpus, parseWindowsRegistryGpuRows(rows))
  } catch {
    // Registry VRAM is best-effort; keep WMI-only results.
  }

  try {
    const nvidiaGpus = await queryNvidiaSmiGpus()
    return applyNvidiaSmiMemory(gpus, nvidiaGpus)
  } catch {
    return gpus
  }
}

async function queryNvidiaSmiGpus(): Promise<NvidiaSmiGpuInfo[]> {
  const { stdout } = await execFileAsync('nvidia-smi', [
    '--query-gpu=name,memory.total,driver_version',
    '--format=csv,noheader,nounits'
  ])

  return parseNvidiaSmiGpuRows(stdout)
}

export function parseNvidiaSmiGpuRows(stdout: string): NvidiaSmiGpuInfo[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [nameRaw, memoryRaw, driverRaw] = line.split(',').map((part) => part.trim())
      if (!nameRaw) return null

      return {
        name: nameRaw,
        memoryTotalMiB: parseNvidiaSmiMemoryMiB(memoryRaw),
        driverVersion: driverRaw || null
      }
    })
    .filter((gpu): gpu is NvidiaSmiGpuInfo => gpu !== null)
}

export function applyNvidiaSmiMemory(
  gpus: WindowsGpuInfo[],
  nvidiaGpus: NvidiaSmiGpuInfo[]
): WindowsGpuInfo[] {
  if (nvidiaGpus.length === 0) {
    return gpus
  }

  const next = [...gpus]
  const usedIndexes = new Set<number>()

  for (const nvidiaGpu of nvidiaGpus) {
    const adapterRamGiB =
      nvidiaGpu.memoryTotalMiB != null ? mibToGiB(nvidiaGpu.memoryTotalMiB) : null
    const matchIndex = findNvidiaGpuMatchIndex(next, nvidiaGpu.name, usedIndexes)

    if (matchIndex >= 0) {
      usedIndexes.add(matchIndex)
      next[matchIndex] = {
        ...next[matchIndex],
        adapterRamGiB: adapterRamGiB ?? next[matchIndex].adapterRamGiB
      }
      continue
    }

    next.push({
      name: nvidiaGpu.name,
      vendor: 'nvidia',
      adapterRamGiB
    })
    usedIndexes.add(next.length - 1)
  }

  return next
}

function findNvidiaGpuMatchIndex(
  gpus: WindowsGpuInfo[],
  nvidiaSmiName: string,
  usedIndexes: Set<number>
): number {
  const normalizedNvidiaName = normalizeGpuName(nvidiaSmiName)
  const exactNameMatch = gpus.findIndex(
    (gpu, index) =>
      !usedIndexes.has(index) &&
      gpu.vendor === 'nvidia' &&
      namesLikelyReferToSameGpu(normalizeGpuName(gpu.name), normalizedNvidiaName)
  )

  if (exactNameMatch >= 0) {
    return exactNameMatch
  }

  return gpus.findIndex((gpu, index) => !usedIndexes.has(index) && gpu.vendor === 'nvidia')
}

function normalizeGpuName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(nvidia|geforce|laptop|gpu|graphics)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function namesLikelyReferToSameGpu(left: string, right: string): boolean {
  return left.length > 0 && right.length > 0 && (left.includes(right) || right.includes(left))
}

function parseNvidiaSmiMemoryMiB(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseFloat(value.replace(/\s*MiB$/i, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
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

function mibToGiB(mebibytes: number): number {
  return Number((mebibytes / 1024).toFixed(2))
}

export function electronMemoryKbToGiB(kilobytes: number): number {
  return Number((kilobytes / 1024 / 1024).toFixed(2))
}
