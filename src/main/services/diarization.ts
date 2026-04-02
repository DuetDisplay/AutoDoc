import { app } from 'electron'
import { access, mkdir } from 'fs/promises'
import { join } from 'path'
import { spawn, execSync } from 'child_process'
import { PYTHON_ENV_SUBDIR } from '../../shared/constants'

const IS_WIN = process.platform === 'win32'

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

export class DiarizationService {
  private ready = false
  private setupPromise: Promise<void> | null = null

  private getEnvDir(): string {
    return join(app.getPath('userData'), PYTHON_ENV_SUBDIR)
  }

  private getPythonPath(): string {
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

  async isReady(): Promise<boolean> {
    if (this.ready) return true
    try {
      await access(this.getPythonPath())
      this.ready = true
      return true
    } catch {
      return false
    }
  }

  async ensureReady(): Promise<void> {
    if (await this.isReady()) return
    if (this.setupPromise) return this.setupPromise
    this.setupPromise = this.setup()
    try {
      await this.setupPromise
    } finally {
      this.setupPromise = null
    }
  }

  private async setup(): Promise<void> {
    const envDir = this.getEnvDir()
    await mkdir(envDir, { recursive: true })

    let python3: string
    try {
      const cmd = IS_WIN ? 'where.exe python' : 'which python3'
      python3 = execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0]
    } catch {
      console.warn('Python 3 not found — speaker diarization will be unavailable.')
      return
    }

    await this.runCommand(python3, ['-m', 'venv', envDir])

    const pip = IS_WIN ? join(envDir, 'Scripts', 'pip.exe') : join(envDir, 'bin', 'pip')
    await this.runCommand(pip, ['install', '--upgrade', 'pip'])
    await this.runCommand(pip, [
      'install',
      'pyannote.audio',
      'torch',
      'torchaudio',
      'soundfile',
    ])

    this.ready = true
  }

  async diarize(wavPath: string): Promise<DiarizationResult> {
    await this.ensureReady()

    if (!this.ready) {
      return { speakers: [] }
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.getPythonPath(), [this.getScriptPath(), wavPath], {
        env: { ...process.env, HF_TOKEN: process.env.HF_TOKEN ?? '' },
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      const timeout = setTimeout(() => {
        proc.kill()
        reject(new Error('Diarization timed out after 30 minutes'))
      }, 30 * 60 * 1000)

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

  private runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args)
      let stderr = ''
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-500)}`))
      })
    })
  }
}
