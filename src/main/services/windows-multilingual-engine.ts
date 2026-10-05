import { readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { MeetingAsrRoute } from '../../shared/meeting-language'
import type { WindowsProcessingProfileId } from './windows-processing-profile'
import {
  CANARY_CUDA_MIN_VRAM_GIB,
  isLikelyDiscreteGpuName,
  PARAKEET_RUNTIME_FILENAME,
  WINDOWS_TRANSCRIPTION_PROFILES,
  type WindowsGpuInfo,
  type WindowsTranscriptionAsset,
  type WindowsTranscriptionBackendId,
  type WindowsTranscriptionProfile
} from './windows-transcription-runtime'

export { CANARY_CUDA_MIN_VRAM_GIB }

export const WINDOWS_MULTILINGUAL_SELF_TEST_CACHE_FILENAME = 'windows-multilingual-self-test.json'

export type WindowsMultilingualEngineId =
  | 'canary-cuda'
  | 'canary-cpu'
  | 'whisper-turbo-cuda'
  | 'whisper-turbo-vulkan'
  | 'whisper-turbo-cpu'

export type WindowsMultilingualAvailability = 'available' | 'slower' | 'locked'

export type WindowsMultilingualSelfTestOutcome = 'passed' | 'failed' | 'untested'

export type WindowsMultilingualGpuVendor = 'nvidia' | 'amd' | 'intel' | 'none'

export interface WindowsMultilingualGpuSnapshot {
  vendor: WindowsMultilingualGpuVendor
  name: string
  vramGiB: number | null
  discrete: boolean
  driverVersion: string | null
}

export type WindowsMultilingualSelfTestMap = Partial<
  Record<WindowsMultilingualEngineId, WindowsMultilingualSelfTestOutcome>
>

export interface WindowsMultilingualEngineChoice {
  engine: WindowsMultilingualEngineId
  availability: WindowsMultilingualAvailability
  reason: string | null
}

export interface WindowsMultilingualEnginePlan {
  route: MeetingAsrRoute
  kind: 'unchanged' | 'resolved'
  primary: WindowsMultilingualEngineChoice | null
  fallbacks: WindowsMultilingualEngineChoice[]
  availability: WindowsMultilingualAvailability
  reason: string | null
}

export interface ResolveWindowsMultilingualEngineInput {
  route: MeetingAsrRoute
  profileId: WindowsProcessingProfileId
  gpu: WindowsMultilingualGpuSnapshot
  selfTests?: WindowsMultilingualSelfTestMap
  languageLabel?: string
  /**
   * minVramGiB for canary-cuda. Defaults to CANARY_CUDA_MIN_VRAM_GIB (6),
   * matching faster-whisper-cuda and the canary-cuda profile.
   */
  canaryCudaMinVramGiB?: number
  profiles?: Record<WindowsTranscriptionBackendId, WindowsTranscriptionProfile>
}

export interface WindowsMultilingualSelfTestRecord {
  key: string
  engine: WindowsMultilingualEngineId
  gpuName: string
  driverVersion: string
  assetVersion: string
  result: 'passed' | 'failed'
  reason?: string
  testedAt: string
}

export interface WindowsMultilingualSelfTestStore {
  version: 1
  records: Record<string, WindowsMultilingualSelfTestRecord>
}

const EMPTY_GPU_SNAPSHOT: WindowsMultilingualGpuSnapshot = {
  vendor: 'none',
  name: '',
  vramGiB: null,
  discrete: false,
  driverVersion: null
}

export function windowsMultilingualSelfTestCachePath(userDataDir: string): string {
  return join(userDataDir, WINDOWS_MULTILINGUAL_SELF_TEST_CACHE_FILENAME)
}

export function buildWindowsMultilingualSelfTestKey(input: {
  engine: WindowsMultilingualEngineId
  gpuName: string
  driverVersion: string
  assetVersion: string
}): string {
  return [input.engine, input.gpuName, input.driverVersion, input.assetVersion].join('\u001f')
}

export function windowsMultilingualAssetVersion(
  engineId: WindowsMultilingualEngineId,
  profiles: Record<
    WindowsTranscriptionBackendId,
    WindowsTranscriptionProfile
  > = WINDOWS_TRANSCRIPTION_PROFILES
): string {
  return listWindowsMultilingualEngineAssets(engineId, profiles)
    .map((asset) => `${asset.filename}:${asset.sha256 || asset.bytes || ''}`)
    .join('|')
}

export function lookupWindowsMultilingualSelfTest(
  store: WindowsMultilingualSelfTestStore | null | undefined,
  key: string
): WindowsMultilingualSelfTestRecord | null {
  if (!store || store.version !== 1) {
    return null
  }
  const record = store.records[key]
  if (!record || record.key !== key) {
    return null
  }
  return record
}

export function upsertWindowsMultilingualSelfTest(
  store: WindowsMultilingualSelfTestStore | null | undefined,
  record: WindowsMultilingualSelfTestRecord
): WindowsMultilingualSelfTestStore {
  const records =
    store?.version === 1
      ? { ...store.records }
      : ({} as Record<string, WindowsMultilingualSelfTestRecord>)
  records[record.key] = record
  return { version: 1, records }
}

export function invalidateWindowsMultilingualSelfTestsForEngine(
  store: WindowsMultilingualSelfTestStore | null | undefined,
  engine: WindowsMultilingualEngineId
): WindowsMultilingualSelfTestStore {
  const records: Record<string, WindowsMultilingualSelfTestRecord> = {}
  if (store?.version === 1) {
    for (const [key, record] of Object.entries(store.records)) {
      if (record.engine !== engine) {
        records[key] = record
      }
    }
  }
  return { version: 1, records }
}

export function selfTestMapFromStore(
  store: WindowsMultilingualSelfTestStore | null | undefined,
  keys: Partial<Record<WindowsMultilingualEngineId, string>>
): WindowsMultilingualSelfTestMap {
  const map: WindowsMultilingualSelfTestMap = {}
  for (const [engine, key] of Object.entries(keys) as Array<
    [WindowsMultilingualEngineId, string | undefined]
  >) {
    if (!key) continue
    map[engine] = lookupWindowsMultilingualSelfTest(store, key)?.result ?? 'untested'
  }
  return map
}

export async function readWindowsMultilingualSelfTestStore(
  path: string
): Promise<WindowsMultilingualSelfTestStore | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as WindowsMultilingualSelfTestStore
    if (value?.version !== 1 || typeof value.records !== 'object' || value.records == null) {
      return null
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function writeWindowsMultilingualSelfTestStore(
  path: string,
  store: WindowsMultilingualSelfTestStore
): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(store))
  await rename(temporary, path)
}

export async function writeWindowsMultilingualSelfTestResult(
  path: string,
  record: WindowsMultilingualSelfTestRecord
): Promise<WindowsMultilingualSelfTestStore> {
  const current = await readWindowsMultilingualSelfTestStore(path)
  const next = upsertWindowsMultilingualSelfTest(current, record)
  await writeWindowsMultilingualSelfTestStore(path, next)
  return next
}

export function selectWindowsMultilingualGpuSnapshot(
  gpus: WindowsGpuInfo[]
): WindowsMultilingualGpuSnapshot {
  const ranked = [...gpus].filter((gpu) => gpu.vendor !== 'unknown')
  ranked.sort((left, right) => gpuRank(right) - gpuRank(left))
  const gpu = ranked[0]
  if (!gpu) {
    return EMPTY_GPU_SNAPSHOT
  }

  return {
    vendor: gpu.vendor === 'unknown' ? 'none' : gpu.vendor,
    name: gpu.name,
    vramGiB: gpu.adapterRamGiB,
    discrete: isLikelyDiscreteGpuName(gpu.name, gpu.vendor),
    driverVersion: gpu.driverVersion ?? null
  }
}

function gpuRank(gpu: WindowsGpuInfo): number {
  const discrete = isLikelyDiscreteGpuName(gpu.name, gpu.vendor) ? 1 : 0
  if (gpu.vendor === 'nvidia') return 20 + discrete
  if (gpu.vendor === 'amd' || gpu.vendor === 'intel') return 10 + discrete
  return 0
}

export function lockedNeedsSupportedGraphicsCardReason(languageLabel: string): string {
  return `${languageLabel} needs a supported graphics card on this PC.`
}

export const WINDOWS_MULTILINGUAL_GPU_ENGINE_IDS: readonly WindowsMultilingualEngineId[] = [
  'canary-cuda',
  'whisper-turbo-cuda',
  'whisper-turbo-vulkan'
]

export function isWindowsMultilingualGpuEngine(engineId: WindowsMultilingualEngineId): boolean {
  return WINDOWS_MULTILINGUAL_GPU_ENGINE_IDS.includes(engineId)
}

export function windowsMultilingualEngineLogIdentity(engineId: WindowsMultilingualEngineId): {
  backend: string
  backendLabel: string
  modelName: string
} {
  switch (engineId) {
    case 'canary-cuda':
      return {
        backend: 'canary-cuda-fp32',
        backendLabel: 'Canary NVIDIA transcription',
        modelName: 'canary-1b-v2'
      }
    case 'canary-cpu':
      return {
        backend: 'canary-cpu-int8',
        backendLabel: 'Canary CPU transcription',
        modelName: 'canary-1b-v2'
      }
    case 'whisper-turbo-cuda':
      return {
        backend: 'whisper-turbo-cuda',
        backendLabel: 'Whisper turbo NVIDIA transcription',
        modelName: 'large-v3-turbo'
      }
    case 'whisper-turbo-cpu':
      return {
        backend: 'whisper-turbo-cpu',
        backendLabel: 'Whisper turbo CPU transcription',
        modelName: 'large-v3-turbo'
      }
    case 'whisper-turbo-vulkan':
      return {
        backend: 'whisper-turbo-vulkan',
        backendLabel: 'Whisper turbo Vulkan transcription',
        modelName: 'large-v3-turbo'
      }
  }
}

export function windowsMultilingualWorkerEngine(
  engineId: WindowsMultilingualEngineId
): 'canary' | 'whisper-turbo' | null {
  if (engineId === 'canary-cuda' || engineId === 'canary-cpu') {
    return 'canary'
  }
  if (engineId === 'whisper-turbo-cuda' || engineId === 'whisper-turbo-cpu') {
    return 'whisper-turbo'
  }
  return null
}

export function resolveWindowsMultilingualEngine(
  input: ResolveWindowsMultilingualEngineInput
): WindowsMultilingualEnginePlan {
  if (input.route === 'english') {
    return {
      route: 'english',
      kind: 'unchanged',
      primary: null,
      fallbacks: [],
      availability: 'available',
      reason: null
    }
  }

  if (input.route === 'canary') {
    return resolveCanaryPlan(input)
  }

  return resolveTurboPlan(input)
}

function resolveCanaryPlan(
  input: ResolveWindowsMultilingualEngineInput
): WindowsMultilingualEnginePlan {
  const minVramGiB = input.canaryCudaMinVramGiB ?? CANARY_CUDA_MIN_VRAM_GIB
  const cpu: WindowsMultilingualEngineChoice = {
    engine: 'canary-cpu',
    availability: 'available',
    reason: null
  }

  if (canUseCanaryCuda(input.gpu, input.selfTests, minVramGiB)) {
    const cuda: WindowsMultilingualEngineChoice = {
      engine: 'canary-cuda',
      availability: 'available',
      reason: null
    }
    return {
      route: 'canary',
      kind: 'resolved',
      primary: cuda,
      fallbacks: [cpu],
      availability: 'available',
      reason: null
    }
  }

  return {
    route: 'canary',
    kind: 'resolved',
    primary: cpu,
    fallbacks: [],
    availability: 'available',
    reason: null
  }
}

function resolveTurboPlan(
  input: ResolveWindowsMultilingualEngineInput
): WindowsMultilingualEnginePlan {
  const languageLabel = input.languageLabel?.trim() || 'This language'
  const lockedReason = lockedNeedsSupportedGraphicsCardReason(languageLabel)
  const profiles = input.profiles ?? WINDOWS_TRANSCRIPTION_PROFILES
  const gpuEngine = turboGpuEngine(input.gpu, profiles['whisper-turbo-cuda']?.minVramGiB)
  const gpuUsable = gpuEngine != null && selfTestOf(input.selfTests, gpuEngine) !== 'failed'

  if (gpuUsable && gpuEngine) {
    const primary: WindowsMultilingualEngineChoice = {
      engine: gpuEngine,
      availability: 'available',
      reason: null
    }
    const fallbacks =
      input.profileId === 'win-low-spec'
        ? []
        : [
            {
              engine: 'whisper-turbo-cpu' as const,
              availability: 'slower' as const,
              reason: null
            }
          ]
    return {
      route: 'whisper-turbo',
      kind: 'resolved',
      primary,
      fallbacks,
      availability: 'available',
      reason: null
    }
  }

  if (input.profileId === 'win-low-spec') {
    return {
      route: 'whisper-turbo',
      kind: 'resolved',
      primary: null,
      fallbacks: [],
      availability: 'locked',
      reason: lockedReason
    }
  }

  const cpu: WindowsMultilingualEngineChoice = {
    engine: 'whisper-turbo-cpu',
    availability: 'slower',
    reason: null
  }
  return {
    route: 'whisper-turbo',
    kind: 'resolved',
    primary: cpu,
    fallbacks: [],
    availability: 'slower',
    reason: null
  }
}

function canUseCanaryCuda(
  gpu: WindowsMultilingualGpuSnapshot,
  selfTests: WindowsMultilingualSelfTestMap | undefined,
  minVramGiB: number
): boolean {
  if (gpu.vendor !== 'nvidia') {
    return false
  }
  if (gpu.vramGiB != null && gpu.vramGiB < minVramGiB) {
    return false
  }
  return selfTestOf(selfTests, 'canary-cuda') !== 'failed'
}

function turboGpuEngine(
  gpu: WindowsMultilingualGpuSnapshot,
  minVramGiB: number | undefined
): 'whisper-turbo-cuda' | 'whisper-turbo-vulkan' | null {
  if (gpu.vendor === 'nvidia') {
    if (minVramGiB != null && gpu.vramGiB != null && gpu.vramGiB < minVramGiB) {
      return null
    }
    return 'whisper-turbo-cuda'
  }
  if (gpu.vendor === 'amd' || gpu.vendor === 'intel') {
    return 'whisper-turbo-vulkan'
  }
  return null
}

function selfTestOf(
  selfTests: WindowsMultilingualSelfTestMap | undefined,
  engine: WindowsMultilingualEngineId
): WindowsMultilingualSelfTestOutcome {
  return selfTests?.[engine] ?? 'untested'
}

export function listWindowsMultilingualEngineAssets(
  engineId: WindowsMultilingualEngineId,
  profiles: Record<
    WindowsTranscriptionBackendId,
    WindowsTranscriptionProfile
  > = WINDOWS_TRANSCRIPTION_PROFILES
): WindowsTranscriptionAsset[] {
  const assets = [...(profiles[engineId]?.assets ?? [])]
  if (engineId === 'whisper-turbo-vulkan') {
    const pythonRuntime =
      profiles['canary-cpu']?.assets.find(
        (asset) => asset.filename === PARAKEET_RUNTIME_FILENAME
      ) ??
      profiles['parakeet-cpu']?.assets.find((asset) => asset.filename === PARAKEET_RUNTIME_FILENAME)
    if (pythonRuntime && !assets.some((asset) => asset.filename === pythonRuntime.filename)) {
      assets.push(pythonRuntime)
    }
  }
  return dedupeAssetsByFilename(assets)
}

export function getWindowsRouteFirstUseDownloadBytes(input: {
  route: MeetingAsrRoute
  engineId: WindowsMultilingualEngineId | 'unchanged'
  profiles?: Record<WindowsTranscriptionBackendId, WindowsTranscriptionProfile>
  isAssetPresent?: (filename: string) => boolean
}): number {
  if (input.route === 'english' || input.engineId === 'unchanged') {
    return 0
  }

  const isPresent = input.isAssetPresent ?? (() => false)
  return listWindowsMultilingualEngineAssets(
    input.engineId,
    input.profiles ?? WINDOWS_TRANSCRIPTION_PROFILES
  )
    .filter((asset) => !isPresent(asset.filename))
    .reduce((sum, asset) => sum + (asset.bytes ?? 0), 0)
}

function dedupeAssetsByFilename(assets: WindowsTranscriptionAsset[]): WindowsTranscriptionAsset[] {
  const seen = new Set<string>()
  const unique: WindowsTranscriptionAsset[] = []
  for (const asset of assets) {
    if (seen.has(asset.filename)) continue
    seen.add(asset.filename)
    unique.push(asset)
  }
  return unique
}
