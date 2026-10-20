import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { mkdir, readdir, rename, stat, writeFile } from 'fs/promises'
import { win32 } from 'path'

/**
 * The bundled Ollama/llama.cpp on Windows receives OLLAMA_MODELS in the ANSI
 * code page, so a profile path with a character outside that page (for example
 * a Polish "ł" in the user name) cannot be opened when a model loads. When the
 * models directory is not plain ASCII we move it to an ASCII location instead.
 * macOS passes UTF-8 POSIX paths, so every other platform keeps its directory.
 */

export type OllamaModelsDirStrategy = 'default' | 'programdata' | 'short-path' | 'unavailable'

export interface ResolvedOllamaModelsDir {
  dir: string
  strategy: OllamaModelsDirStrategy
  originalPathAscii: boolean
  migrated: boolean
  migrationError?: string
}

export interface OllamaModelsDirFs {
  mkdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  rename(from: string, to: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface OllamaModelsDirDeps {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  fs: OllamaModelsDirFs
  /** Windows 8.3 short path for an existing directory, or null when unavailable. */
  resolveShortPath(path: string): Promise<string | null>
  log(event: { message: string; context: Record<string, unknown> }): void
  /** When set, the chosen ProgramData directory is recorded here for the uninstaller. */
  markerPath?: string
}

const PROGRAM_DATA_APP_DIR = 'AutoDoc'
const MODEL_CONTENT_ENTRIES = ['manifests', 'blobs']
const SHORT_PATH_TIMEOUT_MS = 2_000

export function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value)
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'UNKNOWN'
}

async function hasModelContent(fs: OllamaModelsDirFs, dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir)
    return entries.some((entry) => MODEL_CONTENT_ENTRIES.includes(entry.toLowerCase()))
  } catch {
    return false
  }
}

/**
 * Move the existing model files into the new directory entry by entry (Windows
 * cannot rename a directory over an existing one). blobs go first and manifests
 * last so a half-finished move never leaves a manifest without its blobs, and a
 * failure rolls the moved entries back so the original stays complete.
 */
async function migrateModelContent(fs: OllamaModelsDirFs, from: string, to: string): Promise<void> {
  const entries = (await fs.readdir(from)).sort((a, b) => {
    const rank = (name: string): number => (name.toLowerCase() === 'manifests' ? 1 : 0)
    return rank(a) - rank(b)
  })
  const moved: string[] = []
  try {
    for (const entry of entries) {
      await fs.rename(win32.join(from, entry), win32.join(to, entry))
      moved.push(entry)
    }
  } catch (error) {
    for (const entry of moved.reverse()) {
      await fs.rename(win32.join(to, entry), win32.join(from, entry)).catch(() => {})
    }
    throw error
  }
}

export async function resolveOllamaModelsDir(
  originalDir: string,
  deps: OllamaModelsDirDeps
): Promise<ResolvedOllamaModelsDir> {
  const originalPathAscii = isPrintableAscii(originalDir)
  const finish = (result: ResolvedOllamaModelsDir): ResolvedOllamaModelsDir => {
    // Never log the raw path or user name; only the strategy and outcome.
    deps.log({
      message: 'ollama models directory resolved',
      context: {
        strategy: result.strategy,
        originalPathAscii: result.originalPathAscii,
        migrated: result.migrated,
        ...(result.migrationError ? { migrationError: result.migrationError } : {})
      }
    })
    return result
  }

  if (deps.platform !== 'win32' || originalPathAscii) {
    return finish({ dir: originalDir, strategy: 'default', originalPathAscii, migrated: false })
  }

  const programData = deps.env.ProgramData ?? deps.env.ALLUSERSPROFILE
  if (programData && isPrintableAscii(programData)) {
    const hash = createHash('sha256').update(originalDir.toLowerCase()).digest('hex').slice(0, 12)
    const target = win32.join(programData, PROGRAM_DATA_APP_DIR, `ollama-data-${hash}`)
    try {
      await deps.fs.mkdir(target)
      let migrated = false
      let migrationError: string | undefined
      if (
        (await hasModelContent(deps.fs, originalDir)) &&
        !(await hasModelContent(deps.fs, target))
      ) {
        try {
          await migrateModelContent(deps.fs, originalDir, target)
          migrated = true
        } catch (error) {
          // The original stays untouched; the regular pull path downloads the model again.
          migrationError = errorCode(error)
        }
      }
      if (deps.markerPath) {
        await deps.fs.writeFile(deps.markerPath, target).catch(() => {})
      }
      return finish({
        dir: target,
        strategy: 'programdata',
        originalPathAscii,
        migrated,
        ...(migrationError ? { migrationError } : {})
      })
    } catch {
      // Fall through to the 8.3 short path.
    }
  }

  try {
    await deps.fs.mkdir(originalDir)
    const shortPath = await deps.resolveShortPath(originalDir)
    if (shortPath && isPrintableAscii(shortPath) && (await deps.fs.exists(shortPath))) {
      return finish({ dir: shortPath, strategy: 'short-path', originalPathAscii, migrated: false })
    }
  } catch {
    // Fall through to keeping the original directory.
  }

  return finish({ dir: originalDir, strategy: 'unavailable', originalPathAscii, migrated: false })
}

/** Asks cmd.exe for the 8.3 name; the path travels in an env var to avoid quoting problems. */
export function resolveWindowsShortPath(path: string): Promise<string | null> {
  const directory = win32.normalize(path)
  // Treat the last component as a directory too. Without its trailing separator,
  // cmd's %~sI can return a malformed alias for some non-ASCII directory layouts.
  const target = directory.endsWith('\\') ? directory : `${directory}\\`
  return new Promise((resolve) => {
    execFile(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', '"for %I in ("%AUTODOC_SHORT_PATH_TARGET%") do @echo %~sI"'],
      {
        env: { ...process.env, AUTODOC_SHORT_PATH_TARGET: target },
        timeout: SHORT_PATH_TIMEOUT_MS,
        windowsHide: true,
        windowsVerbatimArguments: true
      },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const lines = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        resolve(lines[lines.length - 1] ?? null)
      }
    )
  })
}

export function createDefaultOllamaModelsDirDeps(
  options: Pick<OllamaModelsDirDeps, 'log' | 'markerPath'>
): OllamaModelsDirDeps {
  return {
    platform: process.platform,
    env: process.env,
    fs: {
      mkdir: async (path) => {
        await mkdir(path, { recursive: true })
      },
      readdir: (path) => readdir(path),
      rename: (from, to) => rename(from, to),
      writeFile: (path, data) => writeFile(path, data, 'utf8'),
      exists: (path) =>
        stat(path).then(
          () => true,
          () => false
        )
    },
    resolveShortPath: resolveWindowsShortPath,
    ...options
  }
}

let relocatedModelsDir: string | null = null

/** The ProgramData directory in use this session, so storage cleanup can include it. */
export function getRelocatedOllamaModelsDir(): string | null {
  return relocatedModelsDir
}

export function setRelocatedOllamaModelsDir(result: ResolvedOllamaModelsDir): void {
  relocatedModelsDir = result.strategy === 'programdata' ? result.dir : null
}
