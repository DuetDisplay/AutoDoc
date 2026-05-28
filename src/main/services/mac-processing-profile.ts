import { execFile } from 'child_process'
import { totalmem, freemem, availableParallelism, cpus } from 'os'
import { promisify } from 'util'
import { DEFAULT_OLLAMA_MODEL, LOW_SPEC_MAC_OLLAMA_MODEL } from '../../shared/constants'

const execFileAsync = promisify(execFile)

export type MacProcessingProfileId = 'mac-normal' | 'mac-low-spec'
export type MacDualSourceMode = 'concurrent' | 'sequential'
export type MacMemoryPressure = 'green' | 'yellow' | 'red' | 'unknown'

export interface MacHardwareSnapshot {
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  isAppleSilicon: boolean
  chip: string | null
  logicalProcessors: number
  totalMemoryGiB: number | null
  freeMemoryGiB: number | null
  memoryPressure: MacMemoryPressure
  swapUsedGiB: number | null
}

export interface MacProcessingProfile {
  id: MacProcessingProfileId
  label: string
  reason: string
  hardware: MacHardwareSnapshot
  transcriptionBackend: 'mlx-whisper'
  transcriptionModel: 'distil-large-v3'
  notesModel: string
  dualSourceMode: MacDualSourceMode
  notesAfterTranscriptionOnly: boolean
  serializeLocalProcessing: boolean
}

const LOW_SPEC_TOTAL_MEMORY_GIB = 8.5
const LOW_SPEC_FREE_MEMORY_GIB = 3
const HIGH_SWAP_USED_GIB = 2

export async function detectMacHardwareSnapshot(): Promise<MacHardwareSnapshot> {
  const [chip, memoryPressure, swapUsedGiB, freeMemoryGiB] = await Promise.all([
    queryChipName(),
    queryMemoryPressure(),
    querySwapUsedGiB(),
    queryAvailableMemoryGiB()
  ])

  return {
    platform: process.platform,
    arch: process.arch,
    isAppleSilicon: process.platform === 'darwin' && process.arch === 'arm64',
    chip,
    logicalProcessors: getLogicalProcessorCount(),
    totalMemoryGiB: bytesToGiB(totalmem()),
    freeMemoryGiB,
    memoryPressure,
    swapUsedGiB
  }
}

export function selectMacProcessingProfile(hardware: MacHardwareSnapshot): MacProcessingProfile {
  const lowSpecReason = getLowSpecHardwareReason(hardware)
  if (lowSpecReason) {
    return createLowSpecProfile(hardware, lowSpecReason)
  }

  return createNormalProfile(hardware, 'hardware has enough memory for concurrent local processing')
}

export function selectEffectiveMacProcessingProfile(
  stableProfile: MacProcessingProfile,
  runtimeHardware: MacHardwareSnapshot
): MacProcessingProfile {
  if (stableProfile.id === 'mac-low-spec') {
    return createLowSpecProfile(runtimeHardware, stableProfile.reason)
  }

  if (!isMemoryHealthyForConcurrentProcessing(runtimeHardware)) {
    return createLowSpecProfile(
      runtimeHardware,
      'runtime memory pressure, free memory, or swap usage is not healthy for concurrent processing',
      stableProfile.notesModel
    )
  }

  return createNormalProfile(
    runtimeHardware,
    'hardware and current memory pressure allow concurrent local processing'
  )
}

export function isMemoryHealthyForConcurrentProcessing(
  hardware: Pick<MacHardwareSnapshot, 'freeMemoryGiB' | 'memoryPressure' | 'swapUsedGiB'>
): boolean {
  if (hardware.memoryPressure === 'yellow' || hardware.memoryPressure === 'red') {
    return false
  }
  if (hardware.freeMemoryGiB != null && hardware.freeMemoryGiB < LOW_SPEC_FREE_MEMORY_GIB) {
    return false
  }
  if (hardware.swapUsedGiB != null && hardware.swapUsedGiB >= HIGH_SWAP_USED_GIB) {
    return false
  }
  return true
}

function getLowSpecHardwareReason(hardware: MacHardwareSnapshot): string | null {
  if (!hardware.isAppleSilicon) {
    return 'unsupported non-Apple-Silicon Mac profile'
  }
  if (hardware.totalMemoryGiB != null && hardware.totalMemoryGiB <= LOW_SPEC_TOTAL_MEMORY_GIB) {
    return `totalMemoryGiB <= ${LOW_SPEC_TOTAL_MEMORY_GIB}`
  }
  return null
}

function createLowSpecProfile(
  hardware: MacHardwareSnapshot,
  reason: string,
  notesModel = LOW_SPEC_MAC_OLLAMA_MODEL
): MacProcessingProfile {
  return {
    id: 'mac-low-spec',
    label: 'Low-spec Apple Silicon Mac',
    reason,
    hardware,
    transcriptionBackend: 'mlx-whisper',
    transcriptionModel: 'distil-large-v3',
    notesModel,
    dualSourceMode: 'sequential',
    notesAfterTranscriptionOnly: true,
    serializeLocalProcessing: true
  }
}

function createNormalProfile(hardware: MacHardwareSnapshot, reason: string): MacProcessingProfile {
  return {
    id: 'mac-normal',
    label: 'Apple Silicon Mac',
    reason,
    hardware,
    transcriptionBackend: 'mlx-whisper',
    transcriptionModel: 'distil-large-v3',
    notesModel: DEFAULT_OLLAMA_MODEL,
    dualSourceMode: 'concurrent',
    notesAfterTranscriptionOnly: true,
    serializeLocalProcessing: false
  }
}

function getLogicalProcessorCount(): number {
  try {
    if (typeof availableParallelism === 'function') {
      return Math.max(1, availableParallelism())
    }
  } catch {
    // Fall back to os.cpus below.
  }

  try {
    return Math.max(1, cpus().length)
  } catch {
    return 1
  }
}

async function queryChipName(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'machdep.cpu.brand_string'], {
      timeout: 3000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function queryMemoryPressure(): Promise<MacMemoryPressure> {
  if (process.platform !== 'darwin') return 'unknown'
  try {
    const { stdout, stderr } = await execFileAsync('memory_pressure', [], { timeout: 3000 })
    return parseMacMemoryPressureOutput(`${stdout}\n${stderr}`)
  } catch {
    return 'unknown'
  }
}

export function parseMacMemoryPressureOutput(output: string): MacMemoryPressure {
  const normalized = output.toLowerCase()
  const freePercentMatch = normalized.match(
    /system-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/
  )
  if (freePercentMatch) {
    const freePercent = Number.parseFloat(freePercentMatch[1])
    if (Number.isFinite(freePercent)) {
      if (freePercent >= 50) return 'green'
      if (freePercent >= 20) return 'yellow'
      return 'red'
    }
  }

  const pressureMatch = normalized.match(
    /memory pressure:\s*(normal|warning|warn|critical|green|yellow|red)\b/
  )
  if (pressureMatch) {
    const value = pressureMatch[1]
    if (value === 'critical' || value === 'red') return 'red'
    if (value === 'warning' || value === 'warn' || value === 'yellow') return 'yellow'
    return 'green'
  }

  if (/\bcritical\b|\bred\b/.test(normalized)) return 'red'
  if (/\bwarning\b|\bwarn\b|\byellow\b/.test(normalized)) return 'yellow'
  if (/\bnormal\b|\bgreen\b/.test(normalized)) return 'green'
  return 'unknown'
}

async function queryAvailableMemoryGiB(): Promise<number | null> {
  if (process.platform !== 'darwin') return bytesToGiB(freemem())
  try {
    const { stdout } = await execFileAsync('vm_stat', [], { timeout: 3000 })
    return parseMacAvailableMemoryGiBFromVmStat(stdout)
  } catch {
    return bytesToGiB(freemem())
  }
}

export function parseMacAvailableMemoryGiBFromVmStat(output: string): number | null {
  const pageSizeMatch = output.match(/page size of\s+(\d+)\s+bytes/i)
  const pageSize = pageSizeMatch ? Number.parseInt(pageSizeMatch[1], 10) : 4096
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null

  const readPages = (label: string): number => {
    const match = output.match(new RegExp(`${label}:\\s+([\\d.]+)\\.`, 'i'))
    if (!match) return 0
    const pages = Number.parseFloat(match[1])
    return Number.isFinite(pages) ? pages : 0
  }

  const availablePages =
    readPages('Pages free') + readPages('Pages inactive') + readPages('Pages speculative')
  return Number(((availablePages * pageSize) / 1024 / 1024 / 1024).toFixed(2))
}

async function querySwapUsedGiB(): Promise<number | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'vm.swapusage'], { timeout: 3000 })
    const match = stdout.match(/used\s*=\s*([\d.]+)([MGT])?/i)
    if (!match) return null

    const value = Number.parseFloat(match[1])
    if (!Number.isFinite(value)) return null
    const unit = (match[2] ?? 'M').toUpperCase()
    if (unit === 'G') return Number(value.toFixed(2))
    if (unit === 'T') return Number((value * 1024).toFixed(2))
    return Number((value / 1024).toFixed(2))
  } catch {
    return null
  }
}

function bytesToGiB(bytes: number): number {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2))
}
