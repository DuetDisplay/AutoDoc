import { spawnSync } from 'child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join, resolve, sep, win32 } from 'path'
import { describe, expect, it } from 'vitest'
import {
  createDefaultOllamaModelsDirDeps,
  isPrintableAscii,
  resolveOllamaModelsDir,
  resolveWindowsShortPath
} from '../ollama-models-dir'

async function removeFixture(root: string, temp: string): Promise<void> {
  if (!root.startsWith(`${temp}${sep}`) || !basename(root).startsWith('autodoc-short-path-')) {
    throw new Error('Refusing cleanup outside the test temporary directory')
  }
  await rm(root, { recursive: true, force: true })
}

describe.skipIf(process.platform !== 'win32')('real Windows short-path fallback', () => {
  for (const userName of ['Testł', 'Testł & team (QA) %qa%!']) {
    it(`opens the same real directory for ${userName} with and without a trailing separator`, async (context) => {
      const temp = resolve(tmpdir())
      const root = await mkdtemp(join(temp, 'autodoc-short-path-'))
      try {
        const directory = join(root, userName, 'short-path-fallback', 'ollama-data')
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'sentinel.txt'), 'independent Unicode path fixture', 'utf8')

        // Capability probe uses UTF-16 stdout so an unsupported volume's long
        // Unicode path is distinguishable from a malformed/ANSI-lossy result.
        const query = spawnSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/u', '/s', '/c', '"for %I in ("%AUTODOC_SHORT_PATH_TARGET%") do @echo %~sI"'],
          {
            env: { ...process.env, AUTODOC_SHORT_PATH_TARGET: `${directory}\\` },
            timeout: 2_000,
            windowsHide: true,
            windowsVerbatimArguments: true
          }
        )
        if (query.error) throw query.error
        expect(query.status).toBe(0)
        const reference = query.stdout.toString('utf16le').trim()
        expect((await stat(reference)).isDirectory()).toBe(true)
        if (!isPrintableAscii(reference)) {
          context.skip('This volume does not provide an all-ASCII 8.3 alias for the fixture')
        }

        for (const input of [directory, `${directory}\\`, directory.replace(/\\/g, '/')]) {
          const alias = await resolveWindowsShortPath(input)
          expect(alias).not.toBeNull()
          expect(isPrintableAscii(alias!)).toBe(true)
          expect(await readFile(join(alias!, 'sentinel.txt'), 'utf8')).toBe(
            'independent Unicode path fixture'
          )
        }

        const blocked = join(root, 'not-a-directory')
        await writeFile(blocked, 'process-local ProgramData fixture', 'utf8')
        const deps = createDefaultOllamaModelsDirDeps({ log: () => {} })
        // Only the dependency environment is staged; real filesystem/short-path
        // calls remain unchanged and the process/system environment stays intact.
        deps.env = { ...process.env, ProgramData: blocked }
        const result = await resolveOllamaModelsDir(directory, deps)
        expect(result.strategy).toBe('short-path')
        expect(isPrintableAscii(result.dir)).toBe(true)
        expect(await readFile(win32.join(result.dir, 'sentinel.txt'), 'utf8')).toBe(
          'independent Unicode path fixture'
        )
      } finally {
        await removeFixture(root, temp)
      }
    }, 15_000)
  }
})
