import { describe, expect, it, vi } from 'vitest'
import {
  isPrintableAscii,
  resolveOllamaModelsDir,
  type OllamaModelsDirDeps,
  type OllamaModelsDirFs
} from '../ollama-models-dir'

const ASCII_DIR = String.raw`C:\Users\tester\AppData\Roaming\AutoDoc\ollama-data`
const NON_ASCII_DIR = 'C:\\Users\\Test\u0142as\\AppData\\Roaming\\AutoDoc\\ollama-data'
const PROGRAM_DATA = String.raw`C:\ProgramData`

/** Tiny in-memory file system: directories map to their entry names. */
function createFakeFs(
  initial: Record<string, string[]>,
  options: { failRenameOf?: string; failMkdirOf?: string } = {}
): OllamaModelsDirFs & { dirs: Map<string, string[]>; renames: Array<[string, string]> } {
  const dirs = new Map(Object.entries(initial))
  const renames: Array<[string, string]> = []
  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('\\'))
  const nameOf = (path: string): string => path.slice(path.lastIndexOf('\\') + 1)
  return {
    dirs,
    renames,
    mkdir: async (path) => {
      if (options.failMkdirOf && path.startsWith(options.failMkdirOf)) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      }
      if (!dirs.has(path)) dirs.set(path, [])
    },
    readdir: async (path) => {
      const entries = dirs.get(path)
      if (!entries) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return [...entries]
    },
    rename: async (from, to) => {
      if (options.failRenameOf && nameOf(from) === options.failRenameOf && from !== to) {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      }
      renames.push([from, to])
      const fromParent = dirs.get(parentOf(from))
      const toParent = dirs.get(parentOf(to))
      if (!fromParent || !toParent) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      fromParent.splice(fromParent.indexOf(nameOf(from)), 1)
      toParent.push(nameOf(to))
    },
    writeFile: async () => {},
    exists: async (path) => dirs.has(path)
  }
}

function createDeps(
  fs: OllamaModelsDirFs,
  overrides: Partial<OllamaModelsDirDeps> = {}
): OllamaModelsDirDeps & { log: ReturnType<typeof vi.fn> } {
  return {
    platform: 'win32',
    env: { ProgramData: PROGRAM_DATA },
    fs,
    resolveShortPath: vi.fn(async () => null),
    log: vi.fn(),
    ...overrides
  } as OllamaModelsDirDeps & { log: ReturnType<typeof vi.fn> }
}

function loggedContext(deps: { log: ReturnType<typeof vi.fn> }): Record<string, unknown> {
  expect(deps.log).toHaveBeenCalledTimes(1)
  const event = deps.log.mock.calls[0][0] as { context: Record<string, unknown> }
  return event.context
}

describe('isPrintableAscii', () => {
  it('accepts plain ASCII paths and rejects any other character', () => {
    expect(isPrintableAscii(ASCII_DIR)).toBe(true)
    expect(isPrintableAscii(NON_ASCII_DIR)).toBe(false)
    expect(isPrintableAscii('')).toBe(false)
  })
})

describe('resolveOllamaModelsDir', () => {
  it('keeps an ASCII directory unchanged on Windows', async () => {
    const fs = createFakeFs({})
    const deps = createDeps(fs)

    const result = await resolveOllamaModelsDir(ASCII_DIR, deps)

    expect(result).toEqual({
      dir: ASCII_DIR,
      strategy: 'default',
      originalPathAscii: true,
      migrated: false
    })
    expect(fs.renames).toEqual([])
    expect(loggedContext(deps)).toEqual({
      strategy: 'default',
      originalPathAscii: true,
      migrated: false
    })
  })

  it('keeps a non-ASCII directory unchanged outside Windows', async () => {
    const fs = createFakeFs({})
    const deps = createDeps(fs, { platform: 'darwin' })

    const result = await resolveOllamaModelsDir('/Users/Zoë/Library/AutoDoc/ollama-data', deps)

    expect(result.dir).toBe('/Users/Zoë/Library/AutoDoc/ollama-data')
    expect(result.strategy).toBe('default')
    expect(result.originalPathAscii).toBe(false)
    expect(deps.resolveShortPath).not.toHaveBeenCalled()
  })

  it('moves model content to a per-user ProgramData directory', async () => {
    const fs = createFakeFs({
      [NON_ASCII_DIR]: ['manifests', 'blobs']
    })
    const deps = createDeps(fs)

    const result = await resolveOllamaModelsDir(NON_ASCII_DIR, deps)

    expect(result.strategy).toBe('programdata')
    expect(result.dir).toMatch(/^C:\\ProgramData\\AutoDoc\\ollama-data-[0-9a-f]{12}$/)
    expect(isPrintableAscii(result.dir)).toBe(true)
    expect(result.migrated).toBe(true)
    expect(fs.dirs.get(result.dir)?.sort()).toEqual(['blobs', 'manifests'])
    expect(fs.dirs.get(NON_ASCII_DIR)).toEqual([])
    // blobs first so a manifest never points at blobs that have not moved yet.
    expect(fs.renames.map(([from]) => from.slice(from.lastIndexOf('\\') + 1))).toEqual([
      'blobs',
      'manifests'
    ])
    expect(loggedContext(deps)).toEqual({
      strategy: 'programdata',
      originalPathAscii: false,
      migrated: true
    })
  })

  it('derives the same directory for the same profile and different ones for different profiles', async () => {
    const first = await resolveOllamaModelsDir(NON_ASCII_DIR, createDeps(createFakeFs({})))
    const again = await resolveOllamaModelsDir(
      NON_ASCII_DIR.toUpperCase(),
      createDeps(createFakeFs({}))
    )
    const other = await resolveOllamaModelsDir(
      'C:\\Users\\Zo\u00eb\\AppData\\Roaming\\AutoDoc\\ollama-data',
      createDeps(createFakeFs({}))
    )

    expect(again.dir).toBe(first.dir)
    expect(other.dir).not.toBe(first.dir)
  })

  it('does not move content when the new directory already has models', async () => {
    const fs = createFakeFs({ [NON_ASCII_DIR]: ['manifests', 'blobs'] })
    const deps = createDeps(fs)
    const first = await resolveOllamaModelsDir(NON_ASCII_DIR, deps)
    // Simulate a second launch with content in both places.
    fs.dirs.set(NON_ASCII_DIR, ['manifests', 'blobs'])
    const second = await resolveOllamaModelsDir(NON_ASCII_DIR, createDeps(fs))

    expect(second.dir).toBe(first.dir)
    expect(second.migrated).toBe(false)
    expect(fs.dirs.get(NON_ASCII_DIR)).toEqual(['manifests', 'blobs'])
  })

  it('keeps the original content and reports the error code when moving fails', async () => {
    const fs = createFakeFs(
      { [NON_ASCII_DIR]: ['manifests', 'blobs'] },
      { failRenameOf: 'manifests' }
    )
    const deps = createDeps(fs)

    const result = await resolveOllamaModelsDir(NON_ASCII_DIR, deps)

    expect(result.strategy).toBe('programdata')
    expect(result.migrated).toBe(false)
    expect(result.migrationError).toBe('EXDEV')
    // blobs moved before the failure were rolled back; the original stays complete.
    expect(fs.dirs.get(NON_ASCII_DIR)?.sort()).toEqual(['blobs', 'manifests'])
    expect(fs.dirs.get(result.dir)).toEqual([])
    expect(loggedContext(deps)).toEqual({
      strategy: 'programdata',
      originalPathAscii: false,
      migrated: false,
      migrationError: 'EXDEV'
    })
  })

  it('falls back to the 8.3 short path when ProgramData is missing', async () => {
    const shortPath = String.raw`C:\Users\TEST~1\AppData\Roaming\AutoDoc\ollama-data`
    const fs = createFakeFs({ [shortPath]: [] })
    const deps = createDeps(fs, {
      env: {},
      resolveShortPath: vi.fn(async () => shortPath)
    })

    const result = await resolveOllamaModelsDir(NON_ASCII_DIR, deps)

    expect(result).toMatchObject({ dir: shortPath, strategy: 'short-path', migrated: false })
    expect(deps.resolveShortPath).toHaveBeenCalledWith(NON_ASCII_DIR)
    expect(loggedContext(deps).strategy).toBe('short-path')
  })

  it('falls back to the short path when ProgramData is non-ASCII or cannot be created', async () => {
    const shortPath = String.raw`C:\Users\TEST~1\AppData\Roaming\AutoDoc\ollama-data`

    const nonAscii = createDeps(createFakeFs({ [shortPath]: [] }), {
      env: { ProgramData: 'C:\\Programme\u00e4' },
      resolveShortPath: vi.fn(async () => shortPath)
    })
    expect((await resolveOllamaModelsDir(NON_ASCII_DIR, nonAscii)).strategy).toBe('short-path')

    const mkdirFails = createDeps(
      createFakeFs({ [shortPath]: [] }, { failMkdirOf: PROGRAM_DATA }),
      { resolveShortPath: vi.fn(async () => shortPath) }
    )
    expect((await resolveOllamaModelsDir(NON_ASCII_DIR, mkdirFails)).strategy).toBe('short-path')
  })

  it('uses ALLUSERSPROFILE when ProgramData is not set', async () => {
    const deps = createDeps(createFakeFs({}), {
      env: { ALLUSERSPROFILE: String.raw`D:\Data` }
    })

    const result = await resolveOllamaModelsDir(NON_ASCII_DIR, deps)

    expect(result.dir).toMatch(/^D:\\Data\\AutoDoc\\ollama-data-[0-9a-f]{12}$/)
  })

  it('keeps the original when the short path is not ASCII or does not exist', async () => {
    const nonAsciiShort = createDeps(createFakeFs({}), {
      env: {},
      resolveShortPath: vi.fn(async () => NON_ASCII_DIR)
    })
    const unchanged = await resolveOllamaModelsDir(NON_ASCII_DIR, nonAsciiShort)
    expect(unchanged).toMatchObject({
      dir: NON_ASCII_DIR,
      strategy: 'unavailable',
      originalPathAscii: false,
      migrated: false
    })
    expect(loggedContext(nonAsciiShort).strategy).toBe('unavailable')

    const missingShort = createDeps(createFakeFs({}), {
      env: {},
      resolveShortPath: vi.fn(async () => String.raw`C:\NOPE~1\ollama-data`)
    })
    expect((await resolveOllamaModelsDir(NON_ASCII_DIR, missingShort)).strategy).toBe('unavailable')
  })

  it('records the chosen ProgramData directory for the uninstaller', async () => {
    const fs = createFakeFs({})
    const writeFile = vi.spyOn(fs, 'writeFile')
    const deps = createDeps(fs, { markerPath: String.raw`C:\marker\ollama-models-dir.txt` })

    const result = await resolveOllamaModelsDir(NON_ASCII_DIR, deps)

    expect(writeFile).toHaveBeenCalledWith(String.raw`C:\marker\ollama-models-dir.txt`, result.dir)
  })

  it('never logs the raw path or user name', async () => {
    const deps = createDeps(createFakeFs({ [NON_ASCII_DIR]: ['blobs'] }))

    await resolveOllamaModelsDir(NON_ASCII_DIR, deps)

    const serialized = JSON.stringify(deps.log.mock.calls)
    expect(serialized).not.toContain('Test')
    expect(serialized).not.toContain('Users')
  })
})
