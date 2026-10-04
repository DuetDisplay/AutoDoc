import { app } from 'electron'
import { spawn } from 'child_process'
import {
  getMeetingAsrRoute,
  getMeetingLanguageDefinition,
  normalizeMeetingLanguage,
  type MeetingLanguageCode
} from '../../shared/meeting-language'
import { logAutodocEvent, logAutodocFailure } from './autodoc-log'
import { TranscriptionWorkerClient } from './transcription-worker-client'
import type { WhisperManager } from './whisper-manager'
import type { WindowsProcessingProfileId } from './windows-processing-profile'
import {
  detectWindowsHardwareProfile,
  type WindowsGpuInfo
} from './windows-transcription-runtime'
import {
  buildWindowsMultilingualSelfTestKey,
  getWindowsRouteFirstUseDownloadBytes,
  isWindowsMultilingualGpuEngine,
  lockedNeedsSupportedGraphicsCardReason,
  readWindowsMultilingualSelfTestStore,
  resolveWindowsMultilingualEngine,
  selectWindowsMultilingualGpuSnapshot,
  selfTestMapFromStore,
  windowsMultilingualAssetVersion,
  windowsMultilingualEngineLogIdentity,
  windowsMultilingualSelfTestCachePath,
  windowsMultilingualWorkerEngine,
  writeWindowsMultilingualSelfTestResult,
  type WindowsMultilingualAvailability,
  type WindowsMultilingualEngineId,
  type WindowsMultilingualEnginePlan,
  type WindowsMultilingualGpuSnapshot,
  type WindowsMultilingualSelfTestMap,
  type WindowsMultilingualSelfTestOutcome
} from './windows-multilingual-engine'

export interface WindowsMultilingualProgress {
  percent: number
  phase: string
}

export interface WindowsMultilingualReadinessHost {
  whisperManager: Pick<
    WhisperManager,
    | 'ensureWindowsEngineAssets'
    | 'areWindowsEngineAssetsPresent'
    | 'isWindowsTranscriptionAssetPresent'
    | 'getWindowsEngineRuntime'
    | 'getWindowsTranscriptionProfiles'
    | 'getEffectiveWindowsProcessingProfile'
    | 'recordWindowsTranscriptionDowngrade'
    | 'getTranscriptionWorkerScriptPath'
    | 'on'
    | 'off'
  >
  userDataDir?: string
  gpu?: WindowsMultilingualGpuSnapshot
  detectGpus?: () => Promise<WindowsGpuInfo[]>
  profileId?: WindowsProcessingProfileId
  skipEngines?: WindowsMultilingualEngineId[]
}

export interface WindowsMeetingLanguageAvailabilityResult {
  availability: WindowsMultilingualAvailability
  reason: string | null
  engineId: WindowsMultilingualEngineId | null
  firstUseDownloadBytes: number
  needsSelfTest: boolean
}

export interface WindowsMultilingualEngineReadyResult {
  engineId: WindowsMultilingualEngineId | null
  availability: WindowsMultilingualAvailability
  reason: string | null
  fallbackFrom?: WindowsMultilingualEngineId
  fallbackReason?: string | null
  selfTest: WindowsMultilingualSelfTestOutcome | null
  pythonPath: string | null
  modelPath: string | null
  processEnv: NodeJS.ProcessEnv
  device: 'cuda' | 'cpu' | 'dml' | null
  computeType: string | null
  workerEngine: 'canary' | 'whisper-turbo' | null
  cliPath: string | null
  scriptPath: string | null
  gpuName: string | null
  plan: WindowsMultilingualEnginePlan
}

export function windowsVulkanBridgeDeviceNameArgs(
  gpuName: string | null | undefined
): string[] {
  const name = gpuName?.trim()
  return name ? ['--device-name', name] : []
}

const SELF_TEST_TIMEOUT_MS = 3 * 60_000

let boundHost: WindowsMultilingualReadinessHost | null = null

export function bindWindowsMultilingualReadiness(host: WindowsMultilingualReadinessHost): void {
  boundHost = host
}

function resolveHost(host?: WindowsMultilingualReadinessHost): WindowsMultilingualReadinessHost {
  const resolved = host ?? boundHost
  if (!resolved) {
    throw new Error('Windows multilingual readiness is not bound to a WhisperManager')
  }
  return resolved
}

function userDataDirOf(host: WindowsMultilingualReadinessHost): string {
  return host.userDataDir ?? app.getPath('userData')
}

export async function getWindowsMeetingLanguageAvailability(
  languageCode: string,
  host?: WindowsMultilingualReadinessHost
): Promise<WindowsMeetingLanguageAvailabilityResult> {
  const resolved = resolveHost(host)
  const language = normalizeMeetingLanguage(languageCode)
  const context = await resolveWindowsMultilingualJobContext(language, resolved)
  if (context.plan.kind === 'unchanged') {
    return {
      availability: 'available',
      reason: null,
      engineId: null,
      firstUseDownloadBytes: 0,
      needsSelfTest: false
    }
  }

  if (context.plan.availability === 'locked' || !context.plan.primary) {
    return {
      availability: 'locked',
      reason: context.plan.reason,
      engineId: null,
      firstUseDownloadBytes: 0,
      needsSelfTest: false
    }
  }

  const engineId = context.plan.primary.engine
  const firstUseDownloadBytes = getWindowsRouteFirstUseDownloadBytes({
    route: context.plan.route,
    engineId,
    profiles: resolved.whisperManager.getWindowsTranscriptionProfiles(),
    isAssetPresent: (filename) => context.installedFilenames.has(filename)
  })
  const needsSelfTest =
    isWindowsMultilingualGpuEngine(engineId) &&
    (context.selfTests[engineId] ?? 'untested') === 'untested'

  return {
    availability: context.plan.availability,
    reason: context.plan.reason,
    engineId,
    firstUseDownloadBytes,
    needsSelfTest
  }
}

export async function ensureWindowsMultilingualEngineReady(
  languageCode: string,
  onProgress?: (progress: WindowsMultilingualProgress) => void,
  host?: WindowsMultilingualReadinessHost
): Promise<WindowsMultilingualEngineReadyResult> {
  const resolved = resolveHost(host)
  const language = normalizeMeetingLanguage(languageCode)
  const context = await resolveWindowsMultilingualJobContext(language, resolved)
  if (context.plan.kind === 'unchanged') {
    return emptyReadyResult(context.plan, 'available')
  }

  if (context.plan.availability === 'locked' || !context.plan.primary) {
    return emptyReadyResult(context.plan, 'locked', context.plan.reason)
  }

  const skip = new Set(resolved.skipEngines ?? [])
  const candidates = [context.plan.primary, ...context.plan.fallbacks].filter(
    (choice) => !skip.has(choice.engine)
  )
  let lastError: Error | null = null
  let fallbackFrom: WindowsMultilingualEngineId | undefined
  let fallbackReason: string | null | undefined

  const onStatus = (status: { percent?: number; phase?: string }): void => {
    onProgress?.({
      percent: typeof status.percent === 'number' ? status.percent : 0,
      phase: status.phase ?? 'downloading'
    })
  }
  resolved.whisperManager.on('setup-status', onStatus)

  try {
    for (const choice of candidates) {
      try {
        await resolved.whisperManager.ensureWindowsEngineAssets(choice.engine)
        let selfTest: WindowsMultilingualSelfTestOutcome = 'untested'
        if (isWindowsMultilingualGpuEngine(choice.engine)) {
          selfTest = await ensureWindowsMultilingualSelfTest({
            engineId: choice.engine,
            language,
            host: resolved,
            gpu: context.gpu
          })
          if (selfTest === 'failed') {
            const reason = `${choice.engine} self-test failed`
            if (fallbackFrom == null) {
              fallbackFrom = choice.engine
              fallbackReason = reason
            }
            const next = nextFallbackEngine(candidates, choice.engine)
            if (next) {
              resolved.whisperManager.recordWindowsTranscriptionDowngrade(choice.engine, next)
            }
            lastError = new Error(reason)
            continue
          }
        }

        const runtime = resolved.whisperManager.getWindowsEngineRuntime(choice.engine)
        return {
          engineId: choice.engine,
          availability: choice.availability,
          reason: choice.reason,
          fallbackFrom,
          fallbackReason,
          selfTest: isWindowsMultilingualGpuEngine(choice.engine) ? selfTest : null,
          pythonPath: runtime.pythonPath,
          modelPath: runtime.modelPath,
          processEnv: runtime.processEnv,
          device: runtime.device,
          computeType: runtime.computeType,
          workerEngine: runtime.workerEngine ?? windowsMultilingualWorkerEngine(choice.engine),
          cliPath: runtime.cliPath,
          scriptPath: runtime.scriptPath,
          gpuName: context.gpu.name || null,
          plan: context.plan
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        logAutodocFailure({
          area: 'whisper',
          message: 'Windows multilingual engine setup failed',
          error: lastError,
          context: { engineId: choice.engine, language }
        })
        if (fallbackFrom == null) {
          fallbackFrom = choice.engine
          fallbackReason = lastError.message
        }
        const next = nextFallbackEngine(candidates, choice.engine)
        if (next) {
          resolved.whisperManager.recordWindowsTranscriptionDowngrade(choice.engine, next)
        }
      }
    }
  } finally {
    resolved.whisperManager.off('setup-status', onStatus)
  }

  if (context.plan.fallbacks.length === 0 && context.plan.primary) {
    const identity = windowsMultilingualEngineLogIdentity(context.plan.primary.engine)
    throw new Error(
      context.plan.reason ??
        lastError?.message ??
        `${identity.backendLabel} is unavailable on this PC.`
    )
  }

  throw (
    lastError ??
    new Error(context.plan.reason ?? lockedNeedsSupportedGraphicsCardReason(context.languageLabel))
  )
}

export async function resolveWindowsMultilingualJobContext(
  language: MeetingLanguageCode,
  host?: WindowsMultilingualReadinessHost
): Promise<{
  language: MeetingLanguageCode
  languageLabel: string
  plan: WindowsMultilingualEnginePlan
  gpu: WindowsMultilingualGpuSnapshot
  selfTests: WindowsMultilingualSelfTestMap
  installedFilenames: Set<string>
}> {
  const resolved = resolveHost(host)
  const definition = getMeetingLanguageDefinition(language)
  const route = getMeetingAsrRoute(language)
  const gpu = await resolveGpuSnapshot(resolved)
  const profileId =
    resolved.profileId ??
    (await resolved.whisperManager.getEffectiveWindowsProcessingProfile())?.id ??
    'win-cpu-normal'
  const profiles = resolved.whisperManager.getWindowsTranscriptionProfiles()
  const store = await readWindowsMultilingualSelfTestStore(
    windowsMultilingualSelfTestCachePath(userDataDirOf(resolved))
  )
  const keys: Partial<Record<WindowsMultilingualEngineId, string>> = {}
  for (const engine of ['canary-cuda', 'whisper-turbo-cuda', 'whisper-turbo-vulkan'] as const) {
    keys[engine] = buildWindowsMultilingualSelfTestKey({
      engine,
      gpuName: gpu.name,
      driverVersion: gpu.driverVersion ?? '',
      assetVersion: windowsMultilingualAssetVersion(engine, profiles)
    })
  }
  const selfTests = selfTestMapFromStore(store, keys)
  const installedFilenames = await listInstalledWindowsAssetFilenames(resolved)
  const plan = resolveWindowsMultilingualEngine({
    route,
    profileId,
    gpu,
    selfTests,
    languageLabel: definition.label,
    profiles
  })

  return {
    language,
    languageLabel: definition.label,
    plan,
    gpu,
    selfTests,
    installedFilenames
  }
}

async function resolveGpuSnapshot(
  host: WindowsMultilingualReadinessHost
): Promise<WindowsMultilingualGpuSnapshot> {
  if (host.gpu) {
    return host.gpu
  }
  const gpus = host.detectGpus
    ? await host.detectGpus()
    : (await detectWindowsHardwareProfile()).gpus
  return selectWindowsMultilingualGpuSnapshot(gpus)
}

async function listInstalledWindowsAssetFilenames(
  host: WindowsMultilingualReadinessHost
): Promise<Set<string>> {
  const filenames = new Set<string>()
  const seen = new Set<string>()
  for (const profile of Object.values(host.whisperManager.getWindowsTranscriptionProfiles())) {
    for (const asset of profile.assets) {
      if (seen.has(asset.filename)) continue
      seen.add(asset.filename)
      if (await host.whisperManager.isWindowsTranscriptionAssetPresent(asset.filename)) {
        filenames.add(asset.filename)
      }
    }
  }
  return filenames
}

async function ensureWindowsMultilingualSelfTest(input: {
  engineId: WindowsMultilingualEngineId
  language: MeetingLanguageCode
  host: WindowsMultilingualReadinessHost
  gpu: WindowsMultilingualGpuSnapshot
}): Promise<WindowsMultilingualSelfTestOutcome> {
  const profiles = input.host.whisperManager.getWindowsTranscriptionProfiles()
  const key = buildWindowsMultilingualSelfTestKey({
    engine: input.engineId,
    gpuName: input.gpu.name,
    driverVersion: input.gpu.driverVersion ?? '',
    assetVersion: windowsMultilingualAssetVersion(input.engineId, profiles)
  })
  const cachePath = windowsMultilingualSelfTestCachePath(userDataDirOf(input.host))
  const current = await readWindowsMultilingualSelfTestStore(cachePath)
  const cached = current?.records[key]
  if (cached?.result === 'passed' || cached?.result === 'failed') {
    return cached.result
  }

  const runtime = input.host.whisperManager.getWindowsEngineRuntime(input.engineId)
  let result: 'passed' | 'failed' = 'failed'
  let reason: string | undefined
  let vulkanDevice: number | null | undefined
  let vulkanDeviceName: string | null | undefined
  try {
    if (input.engineId === 'whisper-turbo-vulkan') {
      const vulkan = await runVulkanSelfTest({
        pythonPath: runtime.pythonPath,
        scriptPath: runtime.scriptPath ?? '',
        modelPath: runtime.modelPath,
        cliPath: runtime.cliPath ?? '',
        env: runtime.processEnv,
        deviceName: input.gpu.name
      })
      vulkanDevice = vulkan.device
      vulkanDeviceName = vulkan.deviceName
    } else {
      await runWorkerSelfTest({
        engineId: input.engineId,
        language: input.language,
        host: input.host,
        runtime
      })
    }
    result = 'passed'
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
    logAutodocFailure({
      area: 'whisper',
      message: 'Windows multilingual GPU self-test failed',
      error,
      context: { engineId: input.engineId }
    })
  }

  await writeWindowsMultilingualSelfTestResult(cachePath, {
    key,
    engine: input.engineId,
    gpuName: input.gpu.name,
    driverVersion: input.gpu.driverVersion ?? '',
    assetVersion: windowsMultilingualAssetVersion(input.engineId, profiles),
    result,
    reason,
    testedAt: new Date().toISOString()
  })
  logAutodocEvent({
    area: 'whisper',
    message: 'Windows multilingual GPU self-test completed',
    context: {
      engineId: input.engineId,
      result,
      ...(input.engineId === 'whisper-turbo-vulkan'
        ? { device: vulkanDevice ?? null, deviceName: vulkanDeviceName ?? null }
        : {})
    }
  })
  return result
}

async function runWorkerSelfTest(input: {
  engineId: WindowsMultilingualEngineId
  language: MeetingLanguageCode
  host: WindowsMultilingualReadinessHost
  runtime: ReturnType<WhisperManager['getWindowsEngineRuntime']>
}): Promise<void> {
  const workerEngine = windowsMultilingualWorkerEngine(input.engineId)
  if (!workerEngine) {
    throw new Error(`${input.engineId} has no worker self-test`)
  }
  const client = new TranscriptionWorkerClient({
    pythonPath: input.runtime.pythonPath,
    scriptPath: input.host.whisperManager.getTranscriptionWorkerScriptPath(),
    processEnv: input.runtime.processEnv
  })
  try {
    const result = await Promise.race([
      client.selftest({
        engine: workerEngine,
        model: input.runtime.modelPath,
        device: input.runtime.device === 'dml' ? 'cpu' : input.runtime.device,
        computeType: input.runtime.computeType,
        threads: 2,
        language: decoderLanguageFor(input.language)
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Windows multilingual self-test timed out')), SELF_TEST_TIMEOUT_MS)
      })
    ])
    if (result.ok === false) {
      throw new Error(`${input.engineId} self-test returned ok=false`)
    }
  } finally {
    await client.disposeAndWait().catch(() => {
      client.dispose()
    })
  }
}

function parseVulkanSelfTestJson(stdout: string): {
  ok?: boolean
  device?: number | null
  deviceName?: string | null
} {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return {}
  }
  try {
    return JSON.parse(trimmed) as {
      ok?: boolean
      device?: number | null
      deviceName?: string | null
    }
  } catch {
    const start = trimmed.lastIndexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as {
          ok?: boolean
          device?: number | null
          deviceName?: string | null
        }
      } catch {
        return {}
      }
    }
    return {}
  }
}

function runVulkanSelfTest(input: {
  pythonPath: string
  scriptPath: string
  modelPath: string
  cliPath: string
  env: NodeJS.ProcessEnv
  deviceName: string
}): Promise<{ device: number | null; deviceName: string | null }> {
  return new Promise((resolve, reject) => {
    const args = [
      input.scriptPath,
      '--model',
      input.modelPath,
      '--cli',
      input.cliPath,
      ...windowsVulkanBridgeDeviceNameArgs(input.deviceName),
      '--self-test'
    ]
    const proc = spawn(input.pythonPath, args, { env: input.env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('whisper-turbo-vulkan self-test timed out'))
    }, SELF_TEST_TIMEOUT_MS)
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const parsed = parseVulkanSelfTestJson(stdout)
      if (code === 0 && parsed.ok !== false) {
        resolve({
          device: typeof parsed.device === 'number' ? parsed.device : null,
          deviceName: parsed.deviceName ?? null
        })
        return
      }
      reject(
        new Error(
          parsed.ok === false
            ? 'whisper-turbo-vulkan self-test returned ok=false'
            : `whisper-turbo-vulkan self-test exited with code ${code}: ${stderr.slice(-500)}`
        )
      )
    })
  })
}

function decoderLanguageFor(language: MeetingLanguageCode): string {
  const definition = getMeetingLanguageDefinition(language)
  return 'decoderLanguage' in definition ? definition.decoderLanguage : language
}

function nextFallbackEngine(
  candidates: Array<{ engine: WindowsMultilingualEngineId }>,
  current: WindowsMultilingualEngineId
): WindowsMultilingualEngineId | null {
  const index = candidates.findIndex((choice) => choice.engine === current)
  return index >= 0 ? (candidates[index + 1]?.engine ?? null) : null
}

function emptyReadyResult(
  plan: WindowsMultilingualEnginePlan,
  availability: WindowsMultilingualAvailability,
  reason: string | null = null
): WindowsMultilingualEngineReadyResult {
  return {
    engineId: null,
    availability,
    reason,
    selfTest: null,
    pythonPath: null,
    modelPath: null,
    processEnv: {},
    device: null,
    computeType: null,
    workerEngine: null,
    cliPath: null,
    scriptPath: null,
    gpuName: null,
    plan
  }
}

export function windowsMultilingualTranscribeLanguage(language: MeetingLanguageCode): string {
  return decoderLanguageFor(language)
}
