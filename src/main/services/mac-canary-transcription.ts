import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

/** 8-bit build chosen in the AD-100 run-4 eval: within noise of full precision, ~40% less memory. */
export const MAC_CANARY_MODEL = 'Mediform/canary-1b-v2-mlx-q8'

export interface MacCanaryTranscriber {
  pythonPath: string
  scriptPath: string
  modelRef: string
  env: NodeJS.ProcessEnv
}

/**
 * macOS transcription for the EU languages: Canary-1B-v2 through mlx-audio, in
 * its own Python runtime. The English MLX runtime is never used or modified.
 *
 * Development only until packaging lands: runs from the runtime at
 * .benchmarks/canary-mlx14-runtime or AUTODOC_MAC_CANARY_PYTHON. Packaged
 * builds return null.
 */
export function resolveMacCanaryTranscriber(): MacCanaryTranscriber | null {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || app.isPackaged) return null

  const roots = [app.getAppPath(), process.cwd()]
  const configuredPython = process.env.AUTODOC_MAC_CANARY_PYTHON?.trim()
  const pythonPath = [
    ...(configuredPython ? [configuredPython] : []),
    ...roots.map((root) =>
      join(root, '.benchmarks', 'canary-mlx14-runtime', 'python', 'bin', 'python3')
    )
  ].find((candidate) => existsSync(candidate))
  const scriptPath = roots
    .map((root) => join(root, 'resources', 'canary-mlx-transcribe.py'))
    .find((candidate) => existsSync(candidate))
  if (!pythonPath || !scriptPath) return null

  const cacheDir =
    process.env.AUTODOC_MAC_CANARY_CACHE_DIR?.trim() ||
    join(app.getPath('userData'), 'models', 'canary-mlx-cache')
  return {
    pythonPath,
    scriptPath,
    modelRef: MAC_CANARY_MODEL,
    env: {
      ...process.env,
      HF_HOME: cacheDir,
      HF_HUB_CACHE: join(cacheDir, 'hub'),
      PYTHONDONTWRITEBYTECODE: '1'
    }
  }
}
