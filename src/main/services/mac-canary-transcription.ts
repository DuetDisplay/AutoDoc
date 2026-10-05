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
 * Packaged builds use the separate bundled runtime. Development also accepts
 * the benchmark runtime and explicit Python/cache overrides.
 */
export function resolveMacCanaryTranscriber(): MacCanaryTranscriber | null {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null

  const roots = [app.getAppPath(), process.cwd()]
  const resourceRoot = process.resourcesPath ?? app.getAppPath()
  const configuredPython = process.env.AUTODOC_MAC_CANARY_PYTHON?.trim()
  const pythonPath = [
    ...(configuredPython ? [configuredPython] : []),
    ...(app.isPackaged
      ? [join(resourceRoot, 'canary-mlx-runtime', 'darwin-arm64', 'python', 'bin', 'python3')]
      : roots.map((root) =>
          join(root, 'vendor', 'canary-mlx-runtime', 'darwin-arm64', 'python', 'bin', 'python3')
        )),
    ...(!app.isPackaged ? roots : []).map((root) =>
      join(root, '.benchmarks', 'canary-mlx14-runtime', 'python', 'bin', 'python3')
    )
  ].find((candidate) => existsSync(candidate))
  const scriptPath = (
    app.isPackaged
      ? [join(resourceRoot, 'canary-mlx-transcribe.py')]
      : roots.map((root) => join(root, 'resources', 'canary-mlx-transcribe.py'))
  ).find((candidate) => existsSync(candidate))
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
