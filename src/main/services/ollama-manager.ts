import { app } from 'electron'
import { access, mkdir, chmod, rm, copyFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { createWriteStream } from 'fs'
import { spawn, execFile, execFileSync, execSync, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { totalmem } from 'os'
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_MODEL,
  MODELS_SUBDIR
} from '../../shared/constants'
import {
  isModelInstalled,
  resolveNotesModelMigration,
  type NotesModelMigrationPlan
} from './notes-model-migration'
import { getInstalledModelsDir, getInstalledOllamaDataDir } from './dev-runtime-paths'
import { canUseSystemRuntimeFallback } from './runtime-policy'
import { logAutodocEvent, logAutodocFailure } from './autodoc-log'
import { sanitizeDiagnosticLogTail } from './diagnostic-log-upload'
import {
  selectOllamaAccelerator,
  shouldRecycleRunnerBetweenWriterChunks,
  type OllamaAccelerator,
  type OllamaAcceleratorDecision
} from './ollama-accelerator'
import { detectWindowsHardwareProfile } from './windows-transcription-runtime'

const OLLAMA_DOWNLOAD_VERSION = 'v0.30.0'
const IS_WIN = process.platform === 'win32'

// QA must never adopt or terminate the production app's managed Ollama process.
const OLLAMA_PORT = __AUTODOC_QA_BUILD__ ? 11436 : 11435
const OLLAMA_HOST = __AUTODOC_QA_BUILD__ ? '127.0.0.1:11436' : '127.0.0.1:11435'
const OLLAMA_BASE_URL = `http://${OLLAMA_HOST}`
const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test' || process.env.AUTODOC_TEST_MODE === '1'
const SHOULD_PULL_ASK_AI_EMBEDDING_MODEL =
  !IS_TEST_RUNTIME && process.env.AUTODOC_ASK_AI_EMBEDDINGS !== '0'
const TEST_OLLAMA_SETUP_SEQUENCE =
  IS_WIN && IS_TEST_RUNTIME && process.env.AUTODOC_TEST_REAL_SETUP === '1'
    ? (process.env.AUTODOC_TEST_OLLAMA_SETUP_SEQUENCE ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : []

type PreferredModelResolver = () => string | null | undefined | Promise<string | null | undefined>

export interface OllamaManagerOptions {
  model?: string
  resolveModel?: PreferredModelResolver
}

export const OLLAMA_START_CANCELLED_ERROR_CODE = 'OLLAMA_START_CANCELLED'

function createOllamaStartCancelledError(): Error & { code: string } {
  return Object.assign(new Error('start cancelled by stop()'), {
    code: OLLAMA_START_CANCELLED_ERROR_CODE
  })
}

export function isOllamaStartCancelledError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && error.code === OLLAMA_START_CANCELLED_ERROR_CODE
  )
}

function consumeTestOllamaSetupStep(): string | null {
  return TEST_OLLAMA_SETUP_SEQUENCE.shift() ?? null
}

export interface ManagedLlamaServer {
  pid: number
  rssMiB: number | null
  numCtx: number | null
}

function parseLlamaServerNumCtx(command: string): number | null {
  const match = command.match(/(?:^|\s)(?:-c|--ctx-size|--ctx_size)\s+(\d+)\b/i)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function normalizeRuntimeDir(runtimeDir: string): string {
  return runtimeDir.replace(/\\/g, '/').toLowerCase()
}

function commandIncludesRuntime(command: string, runtimeDir: string): boolean {
  const runtime = normalizeRuntimeDir(runtimeDir)
  return runtime.length > 0 && command.replace(/\\/g, '/').toLowerCase().includes(runtime)
}

function bytesToRssMiB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

interface WindowsLlamaServerCimRow {
  ProcessId?: number
  ParentProcessId?: number
  WorkingSetSize?: number
  ExecutablePath?: string | null
  CommandLine?: string | null
}

/**
 * Windows Ollama loads the model in a child `ollama.exe runner` (or a
 * `llama-server.exe` in older layouts), not always a process named llama-server.
 * Never treat `ollama.exe serve` as a runner — that is the API process we own.
 */
export function isWindowsManagedNotesRunner(input: {
  pid: number
  command: string
  parentPid?: number | null
  runtimeDir: string
  servePid?: number | null
}): boolean {
  if (input.servePid != null && input.pid === input.servePid) return false
  if (!commandIncludesRuntime(input.command, input.runtimeDir)) return false

  const lower = input.command.toLowerCase()
  if (lower.includes('llama-server')) return true

  const isOllamaExe =
    lower.includes('ollama.exe') || /(^|[\\/])ollama(\.exe)?(\s|$)/i.test(input.command)
  if (!isOllamaExe) return false
  if (/\bserve\b/.test(lower)) return false
  if (/\brunner\b/.test(lower)) return true
  return input.servePid != null && input.parentPid === input.servePid
}

export function parseWindowsLlamaServerCimJson(
  json: string,
  runtimeDir: string,
  servePid?: number | null
): ManagedLlamaServer[] {
  const trimmed = json.trim()
  if (!trimmed || trimmed === 'null') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const byPid = new Map<number, ManagedLlamaServer>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as WindowsLlamaServerCimRow
    const pid = Number(record.ProcessId)
    if (!Number.isFinite(pid)) continue
    const command = String(record.CommandLine || record.ExecutablePath || '')
    const parentPid = Number(record.ParentProcessId)
    if (
      !isWindowsManagedNotesRunner({
        pid,
        command,
        parentPid: Number.isFinite(parentPid) ? parentPid : null,
        runtimeDir,
        servePid
      })
    ) {
      continue
    }
    const workingSet = Number(record.WorkingSetSize)
    byPid.set(pid, {
      pid,
      rssMiB: Number.isFinite(workingSet) ? bytesToRssMiB(workingSet) : null,
      numCtx: parseLlamaServerNumCtx(command)
    })
  }
  return [...byPid.values()]
}

/**
 * WMIC column order is alphabetical, so
 * `ExecutablePath ProcessId WorkingSetSize` is the usual layout. PID is the
 * smaller trailing integer; WorkingSetSize is bytes.
 */
export function formatWmicLlamaServerListing(listing: string): string {
  const lines: string[] = []
  for (const raw of listing.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /executablepath/i.test(line)) continue
    if (!/llama-server/i.test(line)) continue
    const match = line.match(/^(.*?)\s+(\d+)\s+(\d+)\s*$/)
    if (!match) continue
    const command = match[1].trim()
    const first = Number(match[2])
    const second = Number(match[3])
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue
    const workingSetLooksLikeBytes = Math.max(first, second) >= 1024 * 1024
    const pid = workingSetLooksLikeBytes ? Math.min(first, second) : second
    const workingSetBytes = workingSetLooksLikeBytes ? Math.max(first, second) : first
    const rssKb = Math.max(1, Math.round(workingSetBytes / 1024))
    lines.push(`${pid} ${rssKb} ${command}`)
  }
  return lines.join('\n')
}

export function parseManagedLlamaServers(
  listing: string,
  runtimeDir: string
): ManagedLlamaServer[] {
  if (!normalizeRuntimeDir(runtimeDir)) return []

  const byPid = new Map<number, ManagedLlamaServer>()
  for (const raw of listing.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const lower = line.replace(/\\/g, '/').toLowerCase()
    if (!lower.includes('llama-server')) continue
    if (!commandIncludesRuntime(line, runtimeDir)) continue

    const pidFromStart = line.match(/^(\d+)\s+(.*)$/)
    if (pidFromStart) {
      const pid = Number(pidFromStart[1])
      const rest = pidFromStart[2].trim()
      const rssAndCommand = rest.match(/^(\d+)\s+(.*)$/)
      const command = rssAndCommand ? rssAndCommand[2] : rest
      const rssKb = rssAndCommand ? Number(rssAndCommand[1]) : null
      byPid.set(pid, {
        pid,
        rssMiB: rssKb != null && Number.isFinite(rssKb) ? Math.round(rssKb / 1024) : null,
        numCtx: parseLlamaServerNumCtx(command)
      })
      continue
    }

    const pidFromEnd = line.match(/(\d+)\s*$/)
    if (pidFromEnd) {
      const pid = Number(pidFromEnd[1])
      byPid.set(pid, {
        pid,
        rssMiB: null,
        numCtx: parseLlamaServerNumCtx(line)
      })
    }
  }
  return [...byPid.values()]
}

export function parseManagedLlamaServerPids(listing: string, runtimeDir: string): number[] {
  return parseManagedLlamaServers(listing, runtimeDir).map((row) => row.pid)
}

// llama.cpp's Metal runner grows RSS by ~350 MiB per uncached prompt and decode
// throughput decays as it grows (verified against Ollama 0.30.0 directly: 23.4 →
// 18.5 tok/s over 8 varied prompts while RSS went 3.8 → 5.9 GiB). Recycling the
// runner costs one model reload (~5-10s) and restores full speed, which pays for
// itself within the next chunk once decode has degraded.
const RUNNER_RECYCLE_RSS_MIB_LARGE_HOST = 4864 // ~4.75 GiB on hosts with >= 20 GiB RAM
const RUNNER_RECYCLE_RSS_MIB_SMALL_HOST = 4352 // ~4.25 GiB — low-RAM hosts hit swap sooner
const RUNNER_RECYCLE_RSS_MIB_WIN_16G = 3584 // ~3.5 GiB — 16 GB boxes share RAM with GPU drivers
const RUNNER_RECYCLE_RSS_MIB_WIN_LOW = 2560 // ~2.5 GiB — 8 GB Windows cannot absorb Metal-sized RSS

export function getRunnerRecycleRssThresholdMiB(
  totalMemBytes: number,
  platform: NodeJS.Platform = process.platform
): number {
  const totalGiB = totalMemBytes / 1024 ** 3
  if (platform === 'win32') {
    if (totalGiB >= 20) return RUNNER_RECYCLE_RSS_MIB_LARGE_HOST
    if (totalGiB >= 16) return RUNNER_RECYCLE_RSS_MIB_WIN_16G
    return RUNNER_RECYCLE_RSS_MIB_WIN_LOW
  }
  return totalGiB >= 20 ? RUNNER_RECYCLE_RSS_MIB_LARGE_HOST : RUNNER_RECYCLE_RSS_MIB_SMALL_HOST
}

export function selectBloatedLlamaServers(
  servers: ManagedLlamaServer[],
  thresholdMiB: number
): ManagedLlamaServer[] {
  return servers.filter((server) => server.rssMiB != null && server.rssMiB > thresholdMiB)
}

export function parseWindowsNetstatListeningPids(output: string): number[] {
  const pids: number[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const pid = Number(line.trim().split(/\s+/).pop())
    if (Number.isFinite(pid) && pid > 0 && !pids.includes(pid)) {
      pids.push(pid)
    }
  }
  return pids
}

export class OllamaManager extends EventEmitter {
  private process: ChildProcess | null = null
  private model: string
  private resolveModel: PreferredModelResolver | null
  private readyPromise: Promise<void> | null = null
  private startPromise: Promise<void> | null = null
  private recoveryPromise: Promise<void> | null = null
  private startEpoch = 0
  private stopped = false
  private readyServeProcess: ChildProcess | null = null
  private adoptedSystemRuntime = false
  private testServerRunning = false
  private didReapAdoptedRunners = false
  private acceleratorDecision: OllamaAcceleratorDecision | null = null

  constructor(modelOrOptions?: string | OllamaManagerOptions) {
    super()
    const options =
      typeof modelOrOptions === 'string' ? { model: modelOrOptions } : (modelOrOptions ?? {})
    this.model = options.model ?? DEFAULT_OLLAMA_MODEL
    this.resolveModel = options.resolveModel ?? null
  }

  /** Call once at startup. Subsequent calls return the same promise. */
  startAndPull(): Promise<void> {
    if (!this.readyPromise) {
      const epoch = this.beginSetupLifecycle()
      const run = this.selectPreferredModel(epoch).then(() => {
        this.assertStartEpoch(epoch)
        const testStep = consumeTestOllamaSetupStep()
        return testStep
          ? this.runTestSetupStep(testStep, epoch)
          : this.start({}, epoch)
              .then(() => {
                this.assertStartEpoch(epoch)
                return this.prepareNotesModels(epoch)
              })
              .then(() => {
                this.assertStartEpoch(epoch)
                return this.pullOptionalEmbeddingModel(epoch)
              })
              .then(() => {
                this.assertStartEpoch(epoch)
              })
      })
      const promise = run.catch((err) => {
        if (this.readyPromise === promise) {
          // Reset so the next call retries instead of permanently failing
          this.readyPromise = null
        }
        this.assertStartEpoch(epoch)
        throw err
      })
      this.readyPromise = promise
    }
    return this.readyPromise
  }

  private async runTestSetupStep(step: string, epoch: number): Promise<void> {
    this.assertStartEpoch(epoch)
    if (step === 'download-fail') {
      this.testServerRunning = false
      this.emit('download-start', 'ollama')
      await Promise.resolve()
      throw new TypeError('terminated')
    }

    if (step === 'ready') {
      this.emit('download-start', 'ollama')
      this.emit('download-progress', { file: 'ollama', percent: 100 })
      this.emit('download-complete', 'ollama')
      this.emit('pull-start', this.model)
      this.emit('pull-progress', { model: this.model, percent: 100, status: 'success' })
      this.testServerRunning = true
      this.emit('pull-complete', this.model)
      return
    }

    await this.start({}, epoch)
    this.assertStartEpoch(epoch)
    await this.pullModel(this.model, epoch)
    this.assertStartEpoch(epoch)
  }

  /** Wait for startup + model pull to complete. */
  waitUntilReady(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(createOllamaStartCancelledError())
    }
    return this.readyPromise ?? this.startAndPull()
  }

  getBaseUrl(): string {
    return OLLAMA_BASE_URL
  }

  getModel(): string {
    return this.model
  }

  getNotesAccelerator(): OllamaAccelerator {
    if (this.acceleratorDecision) {
      return this.acceleratorDecision.accelerator
    }
    return process.platform === 'darwin' ? 'metal' : 'cpu'
  }

  captureLifecycleEpoch(): number {
    return this.startEpoch
  }

  beginSetupLifecycle(): number {
    if (this.stopped) {
      this.startEpoch += 1
    }
    this.stopped = false
    return this.startEpoch
  }

  assertLifecycleEpoch(epoch: number): void {
    this.assertStartEpoch(epoch)
  }

  latchCpuAccelerator(reason: string): void {
    this.acceleratorDecision = {
      accelerator: 'cpu',
      env: { OLLAMA_VULKAN: '0' },
      reason
    }
    logAutodocEvent({
      area: 'ollama',
      message: 'ollama accelerator latched to cpu',
      context: { reason }
    })
  }

  recoverUnhealthyRuntime(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(createOllamaStartCancelledError())
    }
    if (this.recoveryPromise) {
      return this.recoveryPromise
    }
    const run = this.runUnhealthyRecovery()
    const promise = run.finally(() => {
      if (this.recoveryPromise === promise) {
        this.recoveryPromise = null
      }
    })
    this.recoveryPromise = promise
    return promise
  }

  private async runUnhealthyRecovery(): Promise<void> {
    const epoch = this.startEpoch
    this.assertStartEpoch(epoch)
    if (this.acceleratorDecision?.accelerator === 'vulkan') {
      this.latchCpuAccelerator('vulkan runner died; latched CPU for process lifetime')
    }

    const previousStart = this.startPromise
    const previousProc = this.process
    const run = this.stopThenRespawn(previousStart, previousProc, epoch)
    const occupied = run.finally(() => {
      if (this.startPromise === occupied) {
        this.startPromise = null
      }
    })
    this.startPromise = occupied
    return occupied
  }

  private async stopThenRespawn(
    previousStart: Promise<void> | null,
    previousProc: ChildProcess | null,
    epoch: number
  ): Promise<void> {
    this.assertStartEpoch(epoch)
    if (previousProc) {
      const killed = await this.killProcessAndWait(previousProc)
      this.assertStartEpoch(epoch)
      if (!killed) {
        throw new Error(
          `Ollama serve pid ${previousProc.pid ?? 'unknown'} did not exit; refusing to respawn beside orphan`
        )
      }
      if (this.process === previousProc) {
        this.process = null
      }
      if (this.readyServeProcess === previousProc) {
        this.readyServeProcess = null
      }
    }
    this.assertStartEpoch(epoch)
    this.killProcessOnPort()
    this.killManagedLlamaServers()
    this.didReapAdoptedRunners = false
    this.readyPromise = null
    this.testServerRunning = false
    if (previousStart) {
      await previousStart.catch(() => {})
      this.assertStartEpoch(epoch)
    }
    this.reapLeftoverRunners('recover-unhealthy-runtime')
    this.resetReady()
    this.assertStartEpoch(epoch)
    try {
      await this.startServe({ forceRespawn: true }, epoch)
    } catch (error) {
      this.assertStartEpoch(epoch)
      throw error
    }
  }

  private async resolveAcceleratorDecision(): Promise<OllamaAcceleratorDecision> {
    if (this.acceleratorDecision) {
      return this.acceleratorDecision
    }

    if (process.platform === 'darwin') {
      this.acceleratorDecision = selectOllamaAccelerator({
        platform: 'darwin',
        gpus: [],
        totalMemoryGiB: null,
        vulkanOverride: process.env.AUTODOC_OLLAMA_VULKAN
      })
      return this.acceleratorDecision
    }

    try {
      if (process.platform === 'win32') {
        const hardware = await detectWindowsHardwareProfile()
        this.acceleratorDecision = selectOllamaAccelerator({
          platform: 'win32',
          gpus: hardware.gpus,
          totalMemoryGiB: hardware.totalMemoryGiB,
          vulkanOverride: process.env.AUTODOC_OLLAMA_VULKAN
        })
      } else {
        this.acceleratorDecision = selectOllamaAccelerator({
          platform: process.platform,
          gpus: [],
          totalMemoryGiB: null,
          vulkanOverride: process.env.AUTODOC_OLLAMA_VULKAN
        })
      }
    } catch (error) {
      logAutodocEvent({
        area: 'ollama',
        message: 'ollama accelerator detection failed; falling back to cpu',
        level: 'warn',
        context: { error: error instanceof Error ? error.message : String(error) }
      })
      this.acceleratorDecision = {
        accelerator: 'cpu',
        env: { OLLAMA_VULKAN: '0' },
        reason: 'GPU detection failed; using CPU'
      }
    }

    return (
      this.acceleratorDecision ?? {
        accelerator: 'cpu',
        env: { OLLAMA_VULKAN: '0' },
        reason: 'GPU detection failed; using CPU'
      }
    )
  }

  setModel(model: string): void {
    if (this.model === model) return
    this.model = model
    this.emit('model-selected', model)
  }

  private async selectPreferredModel(epoch: number): Promise<void> {
    if (!this.resolveModel) return

    const preferredModel = await this.resolveModel()
    this.assertStartEpoch(epoch)
    if (!preferredModel) return

    this.setModel(preferredModel)
  }

  private getModelsDir(): string {
    return join(app.getPath('userData'), MODELS_SUBDIR)
  }

  private getRuntimeDir(): string {
    return join(this.getModelsDir(), 'ollama-runtime')
  }

  private getBinaryPath(): string {
    return join(this.getRuntimeDir(), IS_WIN ? 'ollama.exe' : 'ollama')
  }

  private getLlamaServerPath(): string {
    return join(this.getRuntimeDir(), 'llama-server')
  }

  private getOllamaDataDir(): string {
    return this.getInstalledFallbackOllamaDataDir() ?? join(app.getPath('userData'), 'ollama-data')
  }

  async isReady(): Promise<boolean> {
    try {
      await access(this.getBinaryPath())
      if (process.platform === 'darwin' && !this.adoptedSystemRuntime) {
        await access(this.getLlamaServerPath())
      }
      return true
    } catch {
      return false
    }
  }

  async isServerRunning(): Promise<boolean> {
    if (
      IS_WIN &&
      IS_TEST_RUNTIME &&
      process.env.AUTODOC_TEST_REAL_SETUP === '1' &&
      this.testServerRunning
    ) {
      return true
    }

    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(2000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  async listInstalledModels(): Promise<string[]> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000)
      })
      if (!res.ok) return []
      const data = (await res.json()) as { models?: { name: string }[] }
      return (data.models ?? []).map((row) => row.name).filter((name) => name.length > 0)
    } catch {
      return []
    }
  }

  async hasModel(model = this.model): Promise<boolean> {
    return isModelInstalled(await this.listInstalledModels(), model)
  }

  async hasUsableNotesModel(): Promise<boolean> {
    return this.hasModel(this.model)
  }

  async deleteModel(model: string): Promise<void> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok && res.status !== 404) {
        throw new Error(`Failed to delete model ${model}: ${res.status}`)
      }
      logAutodocEvent({
        area: 'ollama',
        message: 'deleted leftover notes model',
        context: { model }
      })
    } catch (error) {
      logAutodocFailure({
        area: 'ollama',
        message: 'failed to delete leftover notes model',
        error,
        context: { model }
      })
    }
  }

  private async prepareNotesModels(epoch: number): Promise<void> {
    const preferred = this.model
    const installedModels = await this.listInstalledModels()
    this.assertStartEpoch(epoch)
    const plan = resolveNotesModelMigration({
      preferredModel: preferred,
      installedModels
    })
    this.setModel(plan.activeModel)
    this.emit('notes-model-plan', plan)

    if (plan.pullBeforeReady) {
      await this.pullModel(plan.pullModel, epoch)
      this.assertStartEpoch(epoch)
      this.setModel(plan.pullModel)
      await this.deleteLeftoverModels(plan, epoch)
      this.assertStartEpoch(epoch)
      return
    }

    const installed = await this.listInstalledModels()
    this.assertStartEpoch(epoch)
    if (!isModelInstalled(installed, plan.pullModel)) {
      void this.pullPreferredInBackground(plan, epoch)
      return
    }

    await this.deleteLeftoverModels(plan, epoch)
    this.assertStartEpoch(epoch)
  }

  private async pullPreferredInBackground(
    plan: NotesModelMigrationPlan,
    epoch: number
  ): Promise<void> {
    try {
      this.assertStartEpoch(epoch)
      await this.pullModel(plan.pullModel, epoch)
      this.assertStartEpoch(epoch)
      this.setModel(plan.pullModel)
      const installedModels = await this.listInstalledModels()
      this.assertStartEpoch(epoch)
      const next = resolveNotesModelMigration({
        preferredModel: plan.pullModel,
        installedModels
      })
      await this.deleteLeftoverModels(next, epoch)
    } catch (error) {
      if (isOllamaStartCancelledError(error)) return
      logAutodocFailure({
        area: 'ollama',
        message: 'background preferred notes model pull failed',
        error,
        context: { pullModel: plan.pullModel, activeModel: this.model }
      })
    }
  }

  private async deleteLeftoverModels(plan: NotesModelMigrationPlan, epoch: number): Promise<void> {
    for (const model of plan.leftoverModels) {
      const installedModels = await this.listInstalledModels()
      this.assertStartEpoch(epoch)
      if (isModelInstalled(installedModels, model)) {
        await this.deleteModel(model)
        this.assertStartEpoch(epoch)
      }
    }
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.getModelsDir(), { recursive: true })
    await mkdir(this.getRuntimeDir(), { recursive: true })
    await mkdir(this.getOllamaDataDir(), { recursive: true })

    await this.adoptInstalledRuntimeIfAvailable()

    if (!(await this.isReady())) {
      if (canUseSystemRuntimeFallback()) {
        const systemBinary = this.findSystemOllama()
        if (systemBinary) {
          await copyFile(systemBinary, this.getBinaryPath())
          this.adoptedSystemRuntime = true
          logAutodocEvent({
            area: 'ollama',
            message: 'adopted system ollama runtime'
          })
          return
        }
      }

      await this.downloadBinary()
    }
  }

  private getInstalledFallbackOllamaDataDir(): string | null {
    // A source-run QA build may reuse the installed runtime binary, but it must
    // keep models and process ownership inside the isolated AutoDoc QA profile.
    if (__AUTODOC_QA_BUILD__) return null

    const installedOllamaDataDir = getInstalledOllamaDataDir()
    if (
      !installedOllamaDataDir ||
      installedOllamaDataDir === join(app.getPath('userData'), 'ollama-data') ||
      !existsSync(installedOllamaDataDir)
    ) {
      return null
    }

    return installedOllamaDataDir
  }

  private async adoptInstalledRuntimeIfAvailable(): Promise<void> {
    const installedModelsDir = getInstalledModelsDir()
    if (!installedModelsDir || installedModelsDir === this.getModelsDir()) {
      return
    }

    const installedRuntimeDir = join(installedModelsDir, 'ollama-runtime')
    if (!(await this.fileExists(installedRuntimeDir))) {
      return
    }

    await this.copyDirectoryContentsIfMissing(installedRuntimeDir, this.getRuntimeDir())
  }

  private findSystemOllama(): string | null {
    try {
      const cmd = IS_WIN ? 'where.exe ollama.exe' : 'which ollama'
      const result = execSync(cmd, { encoding: 'utf-8' }).trim()
      return result.split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  start(options: { forceRespawn?: boolean } = {}, expectedEpoch?: number): Promise<void> {
    const epoch = expectedEpoch ?? this.beginSetupLifecycle()
    this.assertStartEpoch(epoch)
    if (this.startPromise) {
      return this.startPromise
    }
    const run = this.startServe(options, epoch).catch((error) => {
      this.assertStartEpoch(epoch)
      throw error
    })
    const promise = run.finally(() => {
      if (this.startPromise === promise) {
        this.startPromise = null
      }
    })
    this.startPromise = promise
    return promise
  }

  private async startServe(
    options: { forceRespawn?: boolean } = {},
    epoch = this.startEpoch
  ): Promise<void> {
    this.assertStartEpoch(epoch)
    await this.ensureReady()
    this.assertStartEpoch(epoch)

    const tracked = this.process
    if (tracked && tracked.exitCode == null && tracked.signalCode == null) {
      if (!options.forceRespawn && this.readyServeProcess === tracked) {
        const running = await this.isServerRunning()
        this.assertStartEpoch(epoch)
        const ownsPort =
          !IS_WIN ||
          (tracked.pid != null && this.getListeningPidsOnOllamaPort().includes(tracked.pid))
        if (running && ownsPort) {
          this.reapManagedLlamaServersOnce('adopt-existing-server')
          return
        }
      }
      const killed = await this.killProcessAndWait(tracked)
      this.assertStartEpoch(epoch)
      if (!killed) {
        throw new Error(
          `Ollama serve pid ${tracked.pid ?? 'unknown'} did not exit; refusing to start beside orphan`
        )
      }
      if (this.process === tracked) {
        this.process = null
      }
      if (this.readyServeProcess === tracked) {
        this.readyServeProcess = null
      }
    } else if (tracked) {
      if (this.process === tracked) {
        this.process = null
      }
      if (this.readyServeProcess === tracked) {
        this.readyServeProcess = null
      }
    }

    this.assertStartEpoch(epoch)

    const existingServerRunning = !options.forceRespawn && (await this.isServerRunning())
    this.assertStartEpoch(epoch)
    if (existingServerRunning) {
      this.reapManagedLlamaServersOnce('adopt-existing-server')
      return
    }

    // Kill any orphaned process holding our port from a previous app session
    this.killProcessOnPort()
    this.reapManagedLlamaServersOnce('replace-orphaned-server')
    await new Promise((r) => setTimeout(r, 1000))
    this.assertStartEpoch(epoch)

    const binary = this.getBinaryPath()
    const spawnStartedAt = Date.now()
    const decision = await this.resolveAcceleratorDecision()
    logAutodocEvent({
      area: 'ollama',
      message: 'ollama accelerator selected',
      context: {
        accelerator: decision.accelerator,
        reason: decision.reason,
        env: Object.keys(decision.env)
      }
    })

    this.assertStartEpoch(epoch)

    const proc = spawn(binary, ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: OLLAMA_HOST,
        OLLAMA_MODELS: this.getOllamaDataDir(),
        ...decision.env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    this.process = proc
    logAutodocEvent({
      area: 'ollama',
      message: 'ollama server spawn attempt',
      context: { binaryPath: binary, pid: proc.pid ?? null }
    })

    if (this.startEpoch !== epoch) {
      const killed = await this.killProcessAndWait(proc)
      if (killed && this.process === proc) {
        this.process = null
      }
      if (killed && this.readyServeProcess === proc) {
        this.readyServeProcess = null
      }
      if (!killed) {
        throw new Error(
          `Ollama serve pid ${proc.pid ?? 'unknown'} did not exit after stop; refusing to continue`
        )
      }
      throw createOllamaStartCancelledError()
    }

    await new Promise<void>((resolve, reject) => {
      let stderr = ''
      let settled = false

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearInterval(pollInterval)
        clearTimeout(timeoutHandle)
        fn()
      }

      const pollInterval = setInterval(() => {
        void (async () => {
          if (!this.isStartEpochCurrent(epoch) || !this.isCurrentLiveChild(proc)) return
          const running = await this.isServerRunning()
          if (!running) return
          if (!this.isStartEpochCurrent(epoch) || !this.isCurrentLiveChild(proc)) return
          if (IS_WIN) {
            const ownerPids = this.getListeningPidsOnOllamaPort()
            if (proc.pid == null || !ownerPids.includes(proc.pid)) return
          }
          markReady()
        })()
      }, 500)

      const timeoutHandle = setTimeout(() => {
        if (settled) return
        settled = true
        clearInterval(pollInterval)
        logAutodocFailure({
          area: 'ollama',
          message: 'ollama server failed to start within timeout',
          error: new Error('Ollama server failed to start within 30 seconds'),
          context: { timeoutMs: 30_000, binaryPath: binary, pid: proc.pid ?? null }
        })
        void this.killProcessAndWait(proc).then((killed) => {
          if (killed) {
            if (this.process === proc) {
              this.process = null
            }
            if (this.readyServeProcess === proc) {
              this.readyServeProcess = null
            }
          } else {
            logAutodocFailure({
              area: 'ollama',
              message: 'ollama server start timeout left an orphan process',
              error: new Error(
                `Ollama serve pid ${proc.pid ?? 'unknown'} did not exit after timeout kill`
              ),
              context: { pid: proc.pid ?? null, binaryPath: binary }
            })
          }
          reject(new Error('Ollama server failed to start within 30 seconds'))
        })
      }, 30_000)

      const markReady = (): void => {
        if (!this.isStartEpochCurrent(epoch) || !this.isCurrentLiveChild(proc)) return
        finish(() => {
          this.readyServeProcess = proc
          logAutodocEvent({
            area: 'ollama',
            message: 'ollama server became ready',
            context: {
              startupMs: Date.now() - spawnStartedAt,
              pid: proc.pid ?? null,
              binaryPath: binary
            }
          })
          resolve()
        })
      }

      let gpuLinesLogged = 0
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        stderr += text
        // Keep only the tail so a long-lived serve cannot grow unbounded, while
        // preserving enough context to diagnose an exit (300 chars was too
        // little — it truncated the crash reason on a user machine).
        if (stderr.length > 8000) {
          stderr = stderr.slice(-8000)
        }
        // GPU discovery and layer placement are the only ground truth for
        // whether notes actually run accelerated; surface them in our logs.
        if (gpuLinesLogged < 12) {
          for (const line of text.split(/\r?\n/)) {
            if (!/inference compute|dropping integrated GPU|offloaded \d+\/\d+ layers/.test(line)) {
              continue
            }
            gpuLinesLogged += 1
            logAutodocEvent({
              area: 'ollama',
              message: 'ollama runtime gpu report',
              context: { line: line.trim().slice(0, 500) }
            })
            if (gpuLinesLogged >= 12) break
          }
        }
        // Ollama logs "Listening on ..." to stderr when ready
        if (stderr.includes('Listening on')) {
          markReady()
        }
      })

      proc.on('error', (err) => {
        if (this.process === proc) {
          this.process = null
        }
        if (this.readyServeProcess === proc) {
          this.readyServeProcess = null
        }
        finish(() => {
          reject(new Error(`Failed to start Ollama: ${err.message}`))
        })
      })

      proc.on('exit', (code, signal) => {
        if (this.process === proc) {
          this.process = null
        }
        if (this.readyServeProcess === proc) {
          this.readyServeProcess = null
        }
        const exitContext = {
          exitCode: code,
          signal: signal ?? null,
          pid: proc.pid ?? null
        }
        const sanitizedStderrTail = sanitizeDiagnosticLogTail(stderr.slice(-300)).trim()
        const exitError =
          code !== null && code !== 0
            ? new Error(
                `Ollama exited with code ${code}${sanitizedStderrTail ? `: ${sanitizedStderrTail}` : ''}`
              )
            : null
        if (exitError) {
          logAutodocFailure({
            area: 'ollama',
            message: 'ollama server process exited',
            error: exitError,
            context: exitContext
          })
        } else {
          logAutodocEvent({
            area: 'ollama',
            message: 'ollama server process exited',
            level: 'warn',
            context: exitContext
          })
        }
        if (!settled) {
          finish(() => {
            reject(
              exitError ??
                new Error(`Ollama exited with code ${code}, signal ${signal}: ${sanitizedStderrTail}`)
            )
          })
        }
      })
    })
    this.assertStartEpoch(epoch)
  }

  stop(): void {
    this.stopped = true
    this.startEpoch += 1
    const proc = this.process
    this.readyServeProcess = null
    if (proc) {
      void this.killProcessAndWait(proc).then((killed) => {
        if (killed && this.process === proc) {
          this.process = null
        }
        if (!killed) {
          logAutodocFailure({
            area: 'ollama',
            message: 'ollama stop left an orphan process',
            error: new Error(`Ollama serve pid ${proc.pid ?? 'unknown'} did not exit during stop`),
            context: { pid: proc.pid ?? null }
          })
        }
      })
    }
    // Also kill any process on our port that we didn't spawn (adopted from a previous session)
    this.killProcessOnPort()
    this.killManagedLlamaServers()
    this.didReapAdoptedRunners = false
    this.readyPromise = null
    this.startPromise = null
    this.recoveryPromise = null
    this.testServerRunning = false
  }

  /** Clear cached ready state so the next startAndPull() actually restarts. */
  resetReady(): void {
    this.readyPromise = null
    this.readyServeProcess = null
    this.testServerRunning = false
  }

  private isCurrentLiveChild(proc: ChildProcess): boolean {
    return this.process === proc && proc.exitCode == null && proc.signalCode == null
  }

  private isStartEpochCurrent(epoch: number): boolean {
    return !this.stopped && this.startEpoch === epoch
  }

  private assertStartEpoch(epoch: number): void {
    if (!this.isStartEpochCurrent(epoch)) {
      throw createOllamaStartCancelledError()
    }
  }

  private getListeningPidsOnOllamaPort(): number[] {
    try {
      const output = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${OLLAMA_PORT}"`, {
        encoding: 'utf-8',
        timeout: 5000
      }).trim()
      return parseWindowsNetstatListeningPids(output)
    } catch {
      return []
    }
  }

  private async killProcessByPid(pid: number): Promise<void> {
    if (!IS_WIN) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already dead
      }
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, 5_000)
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'])
        if (!killer?.on) {
          done()
          return
        }
        killer.on('error', done)
        killer.on('exit', done)
      } catch {
        done()
      }
    })
  }

  private waitForProcessExit(proc: ChildProcess, timeoutMs = 5000): Promise<boolean> {
    if (proc.exitCode != null || proc.signalCode != null) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private async killProcessAndWait(proc: ChildProcess): Promise<boolean> {
    if (proc.pid != null) {
      await this.killProcessByPid(proc.pid)
    } else if (!IS_WIN) {
      proc.kill('SIGTERM')
    }
    if (await this.waitForProcessExit(proc)) {
      return true
    }
    if (proc.pid != null) {
      await this.killProcessByPid(proc.pid)
    } else if (!IS_WIN) {
      proc.kill('SIGTERM')
    }
    return this.waitForProcessExit(proc)
  }

  /**
   * Find and kill any process listening on our port.
   * Handles orphaned Ollama processes left behind by a previous app session
   * where start() found an existing server and never tracked its PID.
   */
  private killProcessOnPort(): void {
    const killedPids: number[] = []
    try {
      if (IS_WIN) {
        const output = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${OLLAMA_PORT}"`, {
          encoding: 'utf-8',
          timeout: 5000
        }).trim()
        const pids = new Set<string>()
        for (const line of output.split(/\r?\n/)) {
          const pid = line.trim().split(/\s+/).pop()
          if (pid && pid !== '0') pids.add(pid)
        }
        for (const pid of pids) {
          try {
            execSync(`taskkill /pid ${pid} /f /t`, { timeout: 5000 })
            killedPids.push(Number(pid))
          } catch {
            // already dead
          }
        }
      } else {
        const pids = execSync(`lsof -ti :${OLLAMA_PORT}`, {
          encoding: 'utf-8',
          timeout: 5000
        }).trim()
        for (const pid of pids.split(/\n/)) {
          if (pid) {
            try {
              process.kill(Number(pid), 'SIGKILL')
              killedPids.push(Number(pid))
            } catch {
              // already dead
            }
          }
        }
      }
    } catch {
      // No process found on the port - nothing to clean up
    }

    if (killedPids.length > 0) {
      logAutodocEvent({
        area: 'ollama',
        message: 'killed orphaned ollama process on port',
        context: { port: OLLAMA_PORT, pids: killedPids }
      })
    }
  }

  reapLeftoverRunners(reason = 'before-profile-snapshot', meetingId?: string): void {
    this.killManagedLlamaServers(reason, meetingId)
  }

  /**
   * Kill managed llama-server runners whose RSS has grown past the recycle
   * threshold. Ollama respawns a fresh runner on the next request, restoring
   * full decode speed. Returns true if any runner was recycled.
   */
  async maybeRecycleBloatedRunners(
    meetingId?: string,
    options?: { betweenChunks?: boolean }
  ): Promise<boolean> {
    if (
      options?.betweenChunks &&
      !shouldRecycleRunnerBetweenWriterChunks(process.platform, this.getNotesAccelerator())
    ) {
      return false
    }
    const thresholdMiB = getRunnerRecycleRssThresholdMiB(totalmem())
    const servers = this.listManagedLlamaServers()
    const bloated = selectBloatedLlamaServers(servers, thresholdMiB)
    logAutodocEvent({
      area: 'ollama',
      message: 'llama-server runner rss check',
      meetingId,
      context: {
        thresholdMiB,
        servers,
        bloatedCount: bloated.length,
        betweenChunks: options?.betweenChunks === true
      }
    })
    if (bloated.length === 0) return false
    this.killManagedLlamaServers(`runner-rss-over-${thresholdMiB}mib`, meetingId)
    await this.ensureServingAfterRunnerChange(meetingId)
    return true
  }

  async ensureServingAfterRunnerChange(meetingId?: string): Promise<void> {
    const epoch = this.captureLifecycleEpoch()
    this.assertLifecycleEpoch(epoch)
    const running = await this.isServerRunning()
    this.assertLifecycleEpoch(epoch)
    if (running) {
      return
    }
    logAutodocEvent({
      area: 'ollama',
      message: 'ollama serve gone after runner kill; restarting',
      meetingId
    })
    await this.start({}, epoch)
  }

  private reapManagedLlamaServersOnce(reason: string): void {
    if (this.didReapAdoptedRunners) return
    this.didReapAdoptedRunners = true
    this.killManagedLlamaServers(reason)
  }

  private listManagedLlamaServers(): ManagedLlamaServer[] {
    const runtimeDir = this.getRuntimeDir()
    if (IS_WIN) {
      return this.listManagedLlamaServersWindows(runtimeDir)
    }
    try {
      const listing = execSync('ps -axo pid=,rss=,command=', { encoding: 'utf-8', timeout: 5000 })
      return parseManagedLlamaServers(listing, runtimeDir)
    } catch {
      return []
    }
  }

  private listManagedLlamaServersWindows(runtimeDir: string): ManagedLlamaServer[] {
    try {
      const json = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe' OR Name='ollama.exe'\" | Select-Object ProcessId,ParentProcessId,WorkingSetSize,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
        ],
        { encoding: 'utf-8', timeout: 8000, windowsHide: true }
      )
      return parseWindowsLlamaServerCimJson(json, runtimeDir, this.process?.pid ?? null)
    } catch {
      // Fall through to WMIC on images where CIM is blocked.
    }

    try {
      const listing = execSync(
        'wmic process where "name=\'llama-server.exe\'" get ExecutablePath,ProcessId,WorkingSetSize',
        { encoding: 'utf-8', timeout: 5000, windowsHide: true }
      )
      return parseManagedLlamaServers(formatWmicLlamaServerListing(listing), runtimeDir)
    } catch {
      return []
    }
  }

  private killManagedLlamaServers(reason = 'stop', meetingId?: string): void {
    const runtimeDir = this.getRuntimeDir()
    const found = this.listManagedLlamaServers()
    const killed: ManagedLlamaServer[] = []
    for (const runner of found) {
      try {
        if (IS_WIN) {
          execSync(`taskkill /pid ${runner.pid} /f`, { timeout: 5000 })
        } else {
          process.kill(runner.pid, 'SIGKILL')
        }
        killed.push(runner)
      } catch {
        // already dead
      }
    }

    const remaining = this.listManagedLlamaServers()
    logAutodocEvent({
      area: 'ollama',
      message: 'reaped llama-server runners',
      meetingId,
      context: {
        reason,
        runtimeDir,
        killed,
        remaining,
        killedCount: killed.length,
        remainingCount: remaining.length
      }
    })
  }

  async pullModel(model = this.model, expectedEpoch?: number): Promise<void> {
    const assertCurrentSetup = (): void => {
      if (expectedEpoch != null) this.assertStartEpoch(expectedEpoch)
    }
    assertCurrentSetup()
    const alreadyInstalled = await this.hasModel(model)
    assertCurrentSetup()
    if (alreadyInstalled) {
      this.emit('pull-complete', model)
      return
    }

    this.emit('pull-start', model)

    const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true })
    })
    assertCurrentSetup()

    if (!res.ok) {
      throw new Error(`Failed to pull model ${model}: ${res.status}`)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body from pull')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      assertCurrentSetup()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const data = JSON.parse(line) as { status?: string; total?: number; completed?: number }
          if (data.total && data.completed) {
            this.emit('pull-progress', {
              model,
              percent: Math.round((data.completed / data.total) * 100),
              status: data.status ?? 'downloading'
            })
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    }

    this.emit('pull-complete', model)
  }

  private async pullOptionalEmbeddingModel(epoch: number): Promise<void> {
    if (!SHOULD_PULL_ASK_AI_EMBEDDING_MODEL) return
    const model = process.env.AUTODOC_ASK_AI_EMBEDDING_MODEL ?? DEFAULT_OLLAMA_EMBEDDING_MODEL
    try {
      await this.pullModel(model, epoch)
    } catch (error) {
      if (isOllamaStartCancelledError(error)) throw error
      this.emit('pull-complete', model)
    }
  }

  private async downloadBinary(): Promise<void> {
    this.emit('download-start', 'ollama')
    const runtimeDir = this.getRuntimeDir()

    if (IS_WIN) {
      await this.downloadBinaryWindows(runtimeDir)
    } else {
      await this.downloadBinaryUnix(runtimeDir)
    }

    this.emit('download-complete', 'ollama')
  }

  private async downloadBinaryWindows(runtimeDir: string): Promise<void> {
    const url = `https://github.com/ollama/ollama/releases/download/${OLLAMA_DOWNLOAD_VERSION}/ollama-windows-amd64.zip`
    const zipPath = join(runtimeDir, 'ollama.zip')

    await this.downloadToFile(url, zipPath)

    // Extract using PowerShell's Expand-Archive
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${runtimeDir}'`
        ],
        (err) => {
          if (err) reject(new Error(`Failed to extract Ollama: ${err.message}`))
          else resolve()
        }
      )
    })

    await rm(zipPath, { force: true })
  }

  private async downloadBinaryUnix(runtimeDir: string): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('Managed Ollama downloads are only supported on macOS and Windows')
    }

    const archiveName = 'ollama-darwin.tgz'
    const archivePath = join(runtimeDir, archiveName)
    const url = `https://github.com/ollama/ollama/releases/download/${OLLAMA_DOWNLOAD_VERSION}/${archiveName}`

    await this.downloadToFile(url, archivePath)

    await new Promise<void>((resolve, reject) => {
      execFile('tar', ['xzf', archivePath, '-C', runtimeDir], (err) => {
        if (err) reject(new Error(`Failed to extract Ollama: ${err.message}`))
        else resolve()
      })
    })

    await chmod(this.getBinaryPath(), 0o755)
    await chmod(this.getLlamaServerPath(), 0o755)
    await rm(archivePath, { force: true })
  }

  private async downloadToFile(url: string, destPath: string): Promise<void> {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) {
      throw new Error(`Failed to download Ollama: ${response.status} ${response.statusText}`)
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let downloadedBytes = 0

    const fileStream = createWriteStream(destPath)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body for Ollama download')

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fileStream.write(value)
        downloadedBytes += value.length
        this.emit('download-progress', {
          file: 'ollama',
          percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
          bytesDownloaded: downloadedBytes,
          bytesTotal: totalBytes
        })
      }
    } finally {
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })
    }
  }

  private async fileExists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath)
      return true
    } catch {
      return false
    }
  }

  private async copyDirectoryContentsIfMissing(sourceDir: string, destDir: string): Promise<void> {
    const entries = await readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(destDir, entry.name)

      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true })
        await this.copyDirectoryContentsIfMissing(sourcePath, destPath)
        continue
      }

      if (!entry.isFile() || (await this.fileExists(destPath))) {
        continue
      }

      await copyFile(sourcePath, destPath)
      if (!IS_WIN && (entry.name === 'ollama' || entry.name === 'llama-server')) {
        await chmod(destPath, 0o755)
      }
    }
  }
}
