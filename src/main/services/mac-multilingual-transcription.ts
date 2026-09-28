import { app } from 'electron'
import { existsSync } from 'fs'
import { delimiter, dirname, join } from 'path'

export const MAC_MULTILINGUAL_MODEL = 'mlx-community/parakeet-tdt-0.6b-v3'

export interface MacMultilingualTranscriber {
  pythonPath: string
  scriptPath: string
  modelRef: string
  env: NodeJS.ProcessEnv
}

/**
 * Non-English macOS transcription: Parakeet TDT 0.6B v3 through parakeet-mlx,
 * in its own Python runtime. The English MLX runtime is never used or modified.
 *
 * Provisional until the Mac runtime bake-off (FluidAudio, parakeet.cpp,
 * parakeet-mlx) picks what ships. Until then it runs only in development, from
 * the runtime built by .benchmarks/prepare-parakeet-mlx-runtime.cjs or
 * AUTODOC_MAC_PARAKEET_PYTHON. Packaged builds return null.
 */
export function resolveMacMultilingualTranscriber(
  ffmpegPath: string
): MacMultilingualTranscriber | null {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || app.isPackaged) return null

  const roots = [app.getAppPath(), process.cwd()]
  const configuredPython = process.env.AUTODOC_MAC_PARAKEET_PYTHON?.trim()
  const pythonPath = [
    ...(configuredPython ? [configuredPython] : []),
    ...roots.map((root) =>
      join(root, '.benchmarks', 'parakeet-mlx-runtime', 'python', 'bin', 'python3')
    )
  ].find((candidate) => existsSync(candidate))
  const scriptPath = roots
    .map((root) => join(root, 'resources', 'parakeet-mlx-transcribe.py'))
    .find((candidate) => existsSync(candidate))
  if (!pythonPath || !scriptPath) return null

  const cacheDir =
    process.env.AUTODOC_MAC_PARAKEET_CACHE_DIR?.trim() ||
    join(app.getPath('userData'), 'models', 'parakeet-mlx-cache')
  return {
    pythonPath,
    scriptPath,
    modelRef: MAC_MULTILINGUAL_MODEL,
    env: {
      ...process.env,
      // parakeet-mlx decodes audio through ffmpeg.
      PATH: [dirname(ffmpegPath), process.env.PATH ?? ''].filter(Boolean).join(delimiter),
      HF_HOME: cacheDir,
      HF_HUB_CACHE: join(cacheDir, 'hub'),
      PYTHONDONTWRITEBYTECODE: '1'
    }
  }
}
