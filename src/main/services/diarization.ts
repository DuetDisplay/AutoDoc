import { app } from 'electron'
import { access, mkdir, rm } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join } from 'path'
import { spawn, execSync, execFile } from 'child_process'
import { EventEmitter } from 'events'
import { PYTHON_ENV_SUBDIR } from '../../shared/constants'
import type { DiarizationSetupStatus } from '../../shared/types'
import {
  getManagedPythonArchiveFilename,
  getManagedPythonDownloadUrl,
  getManagedPythonTarget,
  type ManagedPythonTarget
} from './managed-python'

const IS_WIN = process.platform === 'win32'
const MANAGED_PYTHON_SUBDIR = 'python-runtime'
const MANAGED_MODEL_SUBDIR = 'diarization-model'
const BUNDLED_MODEL_NAME = 'community-1'
const REMOTE_MODEL_ID = 'pyannote/speaker-diarization-community-1'
const PROBE_TIMEOUT_MS = 30_000

export interface DiarizationSegment {
  start: number
  end: number
}

export interface DiarizationSpeaker {
  id: string
  segments: DiarizationSegment[]
}

export interface DiarizationResult {
  speakers: DiarizationSpeaker[]
}

export class DiarizationService extends EventEmitter {
  private ready = false
  private setupPromise: Promise<void> | null = null
  private setupStatus: DiarizationSetupStatus = { phase: 'checking', percent: 0 }

  getSetupStatus(): DiarizationSetupStatus {
    return { ...this.setupStatus }
  }

  startSetup(): Promise<void> {
    if (!this.setupPromise) {
      this.setupPromise = this.runSetup().finally(() => {
        this.setupPromise = null
      })
    }
    return this.setupPromise
  }

  private async runSetup(): Promise<void> {
    try {
      await this.ensureReady(false)
    } catch (err) {
      this.setSetupStatus({
        phase: 'error',
        percent: 0,
        error: err instanceof Error ? err.message : String(err),
        failedStep: this.getFailedStep()
      })
      throw err
    }
  }

  private getEnvDir(): string {
    return join(app.getPath('userData'), PYTHON_ENV_SUBDIR)
  }

  private getPythonPath(): string {
    const bundled = this.getPackagedBundledPythonPath()
    if (bundled) {
      return bundled
    }
    return IS_WIN
      ? join(this.getEnvDir(), 'Scripts', 'python.exe')
      : join(this.getEnvDir(), 'bin', 'python3')
  }

  private getScriptPath(): string {
    const isDev = !app.isPackaged
    if (isDev) {
      return join(app.getAppPath(), 'resources', 'diarize.py')
    }
    return join(process.resourcesPath, 'diarize.py')
  }

  private getBundledArchivePath(target: ManagedPythonTarget): string {
    const archiveName = getManagedPythonArchiveFilename(target)
    if (app.isPackaged) {
      return join(process.resourcesPath, MANAGED_PYTHON_SUBDIR, archiveName)
    }
    return join(app.getAppPath(), 'vendor', MANAGED_PYTHON_SUBDIR, archiveName)
  }

  private getBundledRuntimeDir(target: ManagedPythonTarget): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, MANAGED_PYTHON_SUBDIR, target.key)
    }
    return join(app.getAppPath(), 'vendor', `${MANAGED_PYTHON_SUBDIR}-bundle`, target.key)
  }

  private getBundledRuntimePythonPath(target: ManagedPythonTarget): string {
    return join(this.getBundledRuntimeDir(target), ...target.executableRelativePath)
  }

  private getBundledModelPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, MANAGED_MODEL_SUBDIR, BUNDLED_MODEL_NAME)
    }
    return join(app.getAppPath(), 'vendor', MANAGED_MODEL_SUBDIR, BUNDLED_MODEL_NAME)
  }

  private getRequirementsPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'diarization-requirements.txt')
    }
    return join(app.getAppPath(), 'resources', 'diarization-requirements.txt')
  }

  private getManagedRuntimeRoot(): string {
    return join(app.getPath('userData'), MANAGED_PYTHON_SUBDIR)
  }

  private getProvisionedRuntimeDir(target: ManagedPythonTarget): string {
    return join(this.getManagedRuntimeRoot(), target.key)
  }

  private getProvisionedPythonPath(target: ManagedPythonTarget): string {
    return join(this.getProvisionedRuntimeDir(target), ...target.executableRelativePath)
  }

  private getUserModelPath(): string {
    return join(app.getPath('userData'), MANAGED_MODEL_SUBDIR, BUNDLED_MODEL_NAME)
  }

  private getPackagedBundledPythonPath(): string | null {
    if (!app.isPackaged) {
      return null
    }

    const target = getManagedPythonTarget(process.platform, process.arch)
    if (!target) {
      return null
    }

    return this.getBundledRuntimePythonPath(target)
  }

  private setSetupStatus(status: DiarizationSetupStatus): void {
    this.setupStatus = status
    this.emit('setup-status', this.getSetupStatus())
  }

  async isReady(): Promise<boolean> {
    if (this.ready) return true

    const pythonPath = this.getPythonPath()
    const modelPath = await this.resolveExistingModelPath()
    if (!(await this.fileExists(pythonPath)) || !modelPath) {
      return false
    }

    const usable = await this.isPythonEnvUsable(pythonPath, modelPath)
    this.ready = usable
    return usable
  }

  async ensureReady(awaitActiveSetup = true): Promise<void> {
    if (await this.isReady()) {
      this.markReady()
      return
    }
    if (awaitActiveSetup && this.setupPromise) return this.setupPromise

    const target = getManagedPythonTarget(process.platform, process.arch)
    const packagedBundledPython = this.getPackagedBundledPythonPath()
    if (app.isPackaged && target) {
      if (!packagedBundledPython || !(await this.fileExists(packagedBundledPython))) {
        throw new Error(
          'Bundled speaker diarization runtime is missing. Rebuild after running prepare:python-runtime and prepare:diarization-wheelhouse.'
        )
      }

      let modelPath = await this.resolveExistingModelPath()
      if (!modelPath) {
        this.setSetupStatus({ phase: 'downloading-speaker-model', percent: 75 })
        modelPath = await this.ensureModelReady()
      }
      if (!(await this.isPythonEnvUsable(packagedBundledPython, modelPath))) {
        throw new Error(
          'Bundled speaker diarization runtime did not pass validation after packaging.'
        )
      }

      this.markReady()
      return
    }

    const envDir = this.getEnvDir()
    await mkdir(envDir, { recursive: true })

    const bootstrapPython = await this.resolveBootstrapPython()
    if (!bootstrapPython) {
      throw new Error('Unable to provision Python runtime for speaker diarization.')
    }

    if (!(await this.fileExists(this.getPythonPath()))) {
      this.setSetupStatus({ phase: 'preparing-speaker-runtime', percent: 20 })
      await this.runCommand(bootstrapPython, ['-m', 'venv', envDir])
    }

    this.setSetupStatus({ phase: 'installing-speaker-id', percent: 55 })
    await this.installPythonDependencies()

    let modelPath = await this.resolveExistingModelPath()
    if (!modelPath) {
      this.setSetupStatus({ phase: 'downloading-speaker-model', percent: 75 })
      modelPath = await this.ensureModelReady()
    }

    if (!(await this.isPythonEnvUsable(this.getPythonPath(), modelPath))) {
      throw new Error('Speaker diarization environment did not pass validation after setup.')
    }

    this.markReady()
  }

  private async resolveBootstrapPython(): Promise<string | null> {
    const target = getManagedPythonTarget(process.platform, process.arch)
    if (target) {
      const provisionedPython = this.getProvisionedPythonPath(target)
      if (await this.fileExists(provisionedPython)) {
        return provisionedPython
      }

      const bundledRuntimePython = this.getBundledRuntimePythonPath(target)
      if (await this.fileExists(bundledRuntimePython)) {
        return bundledRuntimePython
      }

      const bundledArchive = this.getBundledArchivePath(target)
      if (await this.fileExists(bundledArchive)) {
        try {
          return await this.provisionManagedRuntimeFromArchive(target, bundledArchive)
        } catch (err) {
          console.warn(
            'Failed to provision bundled Python runtime, attempting network provisioning:',
            err
          )
        }
      }

      try {
        return await this.provisionManagedRuntimeFromDownload(target)
      } catch (err) {
        console.warn(
          'Failed to provision managed Python runtime, falling back to system Python:',
          err
        )
      }
    }

    const systemPython = this.findSystemPython()
    if (systemPython) {
      return systemPython
    }

    return null
  }

  private async ensureModelReady(): Promise<string> {
    const bundledModel = this.getBundledModelPath()
    if (await this.isPipelineDirectory(bundledModel)) {
      return bundledModel
    }

    const userModel = this.getUserModelPath()
    if (await this.isPipelineDirectory(userModel)) {
      return userModel
    }

    const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || ''
    if (!token) {
      throw new Error(
        'Bundled speaker model is missing. Rebuild with HF_TOKEN/HUGGINGFACE_TOKEN so setup can finish offline for end users.'
      )
    }

    await mkdir(join(app.getPath('userData'), MANAGED_MODEL_SUBDIR), { recursive: true })
    await this.downloadModelSnapshot(this.getPythonPath(), userModel, token)
    return userModel
  }

  private async resolveExistingModelPath(): Promise<string | null> {
    const bundledModel = this.getBundledModelPath()
    if (await this.isPipelineDirectory(bundledModel)) {
      return bundledModel
    }

    const userModel = this.getUserModelPath()
    if (await this.isPipelineDirectory(userModel)) {
      return userModel
    }

    return null
  }

  private async isPipelineDirectory(path: string): Promise<boolean> {
    return this.fileExists(join(path, 'config.yaml'))
  }

  private async installPythonDependencies(): Promise<void> {
    const requirementsPath = this.getRequirementsPath()
    await this.runCommand(this.getPythonPath(), ['-m', 'pip', 'install', '--upgrade', 'pip'])
    await this.runCommand(this.getPythonPath(), [
      '-m',
      'pip',
      'install',
      '--requirement',
      requirementsPath
    ])
  }

  private async downloadModelSnapshot(
    pythonPath: string,
    modelPath: string,
    token: string
  ): Promise<void> {
    const code = [
      'import os',
      'from huggingface_hub import snapshot_download',
      'snapshot_download(',
      `    repo_id="${REMOTE_MODEL_ID}",`,
      '    token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN"),',
      `    local_dir=r"${modelPath}",`,
      '    local_dir_use_symlinks=False,',
      ')'
    ].join('\n')

    await this.runCommand(pythonPath, ['-c', code], {
      ...process.env,
      HF_TOKEN: token,
      HUGGINGFACE_TOKEN: token
    })
  }

  private async isPythonEnvUsable(pythonPath: string, modelPath: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      execFile(
        pythonPath,
        [
          '-c',
          'import sys; from pyannote.audio import Pipeline; Pipeline.from_pretrained(sys.argv[1]); print("ok")',
          modelPath
        ],
        {
          windowsHide: true,
          timeout: PROBE_TIMEOUT_MS,
          env: {
            ...process.env,
            PYANNOTE_METRICS_ENABLED: '0'
          }
        },
        (err) => resolve(!err)
      )
    })
  }

  private findSystemPython(): string | null {
    try {
      const cmd = IS_WIN ? 'where.exe python' : 'which python3'
      return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  private async provisionManagedRuntimeFromDownload(target: ManagedPythonTarget): Promise<string> {
    const runtimeRoot = this.getManagedRuntimeRoot()
    await mkdir(runtimeRoot, { recursive: true })

    const archivePath = join(runtimeRoot, getManagedPythonArchiveFilename(target))
    if (!(await this.fileExists(archivePath))) {
      this.setSetupStatus({ phase: 'preparing-speaker-runtime', percent: 5 })
      console.log(`[diarization] Downloading managed Python runtime for ${target.key}`)
      await this.downloadFile(
        getManagedPythonDownloadUrl(target),
        archivePath,
        `python-runtime-${target.key}`
      )
    }

    return await this.provisionManagedRuntimeFromArchive(target, archivePath)
  }

  private async provisionManagedRuntimeFromArchive(
    target: ManagedPythonTarget,
    archivePath: string
  ): Promise<string> {
    const runtimeDir = this.getProvisionedRuntimeDir(target)
    const pythonPath = this.getProvisionedPythonPath(target)

    if (await this.fileExists(pythonPath)) {
      return pythonPath
    }

    this.setSetupStatus({ phase: 'preparing-speaker-runtime', percent: 15 })
    await rm(runtimeDir, { recursive: true, force: true })
    await mkdir(runtimeDir, { recursive: true })
    await this.extractArchive(archivePath, runtimeDir)

    if (!(await this.fileExists(pythonPath))) {
      throw new Error(`Managed Python runtime extracted without expected executable: ${pythonPath}`)
    }

    return pythonPath
  }

  private async extractArchive(archivePath: string, destDir: string): Promise<void> {
    await this.runCommand('tar', ['-xzf', archivePath, '-C', destDir])
  }

  async diarize(wavPath: string): Promise<DiarizationResult> {
    await this.ensureReady()

    if (!this.ready) {
      return { speakers: [] }
    }

    const pipelinePath = await this.resolveExistingModelPath()
    if (!pipelinePath) {
      return { speakers: [] }
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.getPythonPath(), [this.getScriptPath(), wavPath], {
        env: {
          ...process.env,
          HF_TOKEN: process.env.HF_TOKEN ?? '',
          HUGGINGFACE_TOKEN: process.env.HUGGINGFACE_TOKEN ?? '',
          PYANNOTE_PIPELINE: pipelinePath,
          PYANNOTE_METRICS_ENABLED: '0'
        },
        windowsHide: true
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      const timeout = setTimeout(
        () => {
          proc.kill()
          reject(new Error('Diarization timed out after 30 minutes'))
        },
        30 * 60 * 1000
      )

      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          try {
            resolve(JSON.parse(stdout))
          } catch {
            reject(new Error(`Failed to parse diarization output: ${stdout.slice(0, 500)}`))
          }
        } else {
          reject(new Error(`diarize.py exited with code ${code}: ${stderr.slice(-500)}`))
        }
      })
    })
  }

  private getFailedStep(): DiarizationSetupStatus['failedStep'] {
    switch (this.setupStatus.phase) {
      case 'preparing-speaker-runtime':
        return 'preparing-speaker-runtime'
      case 'installing-speaker-id':
        return 'installing-speaker-id'
      case 'downloading-speaker-model':
        return 'downloading-speaker-model'
      default:
        return 'ready'
    }
  }

  private markReady(): void {
    this.ready = true
    if (
      this.setupStatus.phase !== 'ready' ||
      this.setupStatus.percent !== 100 ||
      this.setupStatus.error != null ||
      this.setupStatus.failedStep != null
    ) {
      this.setSetupStatus({ phase: 'ready', percent: 100 })
    }
  }

  private runCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { windowsHide: true, env })
      let stderr = ''
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      proc.on('error', (err) => reject(err))
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-500)}`))
      })
    })
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  private async downloadFile(url: string, destPath: string, label: string): Promise<void> {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) {
      throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`)
    }

    const fileStream = createWriteStream(destPath)
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error(`No response body for ${label}`)
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fileStream.write(value)
      }
    } finally {
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })
    }
  }
}
