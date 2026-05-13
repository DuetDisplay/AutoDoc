import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchPackagedRealSetupApp } from './helpers/electron-app'

const RUN_PACKAGED_MACOS_WHISPER_RUNTIME_TEST =
  process.env.AUTODOC_RUN_PACKAGED_MACOS_WHISPER_RUNTIME_TEST === '1'
const PACKAGED_APP_PATH = process.env.AUTODOC_PACKAGED_APP_PATH ?? ''
const REQUIRED_RUNTIME_FILES = [
  'whisper-cpp',
  'libwhisper.1.dylib',
  'libggml.0.dylib',
  'libggml-base.0.dylib'
]

function listDependencies(filePath: string): string[] {
  const output = execFileSync('otool', ['-L', filePath], { encoding: 'utf8' })
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter(Boolean)
}

function expectPortableRuntimeLinks(filePath: string): void {
  const dependencies = listDependencies(filePath)
  expect(
    dependencies.filter(
      (dependency) =>
        dependency.includes('/opt/homebrew/') ||
        /^@rpath\/(?:libwhisper|libggml|libomp)/.test(dependency)
    )
  ).toEqual([])
}

test.describe('packaged macOS Whisper runtime', () => {
  test('clean install copies the bundled arm64 runtime without Homebrew runtime links', async () => {
    test.skip(
      !RUN_PACKAGED_MACOS_WHISPER_RUNTIME_TEST,
      'Set AUTODOC_RUN_PACKAGED_MACOS_WHISPER_RUNTIME_TEST=1 to run packaged runtime verification.'
    )
    test.skip(process.platform !== 'darwin', 'This packaged runtime test only runs on macOS.')
    test.skip(!PACKAGED_APP_PATH, 'Set AUTODOC_PACKAGED_APP_PATH to a compiled AutoDoc.app.')
    test.skip(!existsSync(PACKAGED_APP_PATH), `Packaged app not found: ${PACKAGED_APP_PATH}`)
    test.skip(process.arch !== 'arm64', 'The bundled macOS Whisper runtime is arm64-only.')
    test.setTimeout(60_000)

    const bundledRuntimeDir = path.join(
      PACKAGED_APP_PATH,
      'Contents',
      'Resources',
      'macos-whisper-runtime',
      'arm64'
    )
    for (const filename of REQUIRED_RUNTIME_FILES) {
      expect(existsSync(path.join(bundledRuntimeDir, filename))).toBeTruthy()
    }

    const app = await launchPackagedRealSetupApp(PACKAGED_APP_PATH)

    try {
      const page = await app.electronApp.firstWindow()
      await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

      const result = await page.evaluate(async () => {
        return await window.electronAPI.invoke('e2e:install-bundled-mac-whisper-runtime')
      })

      expect(result.storagePath).toBe(app.userDataDir)
      expect(result.modelsDir).toBe(path.join(app.userDataDir, 'models'))

      const installedRuntimeFiles = readdirSync(result.modelsDir).filter((filename) =>
        /^(?:whisper-cpp|libwhisper|libggml|libomp).*\.(?:dylib|so)$|^whisper-cpp$/.test(filename)
      )
      for (const filename of REQUIRED_RUNTIME_FILES) {
        expect(installedRuntimeFiles).toContain(filename)
      }

      for (const filename of installedRuntimeFiles) {
        expectPortableRuntimeLinks(path.join(result.modelsDir, filename))
      }

      const whisperHelp = spawnSync(result.whisperPath, ['--help'], { encoding: 'utf8' })
      expect(whisperHelp.status).toBe(0)
      const whisperOutput = `${whisperHelp.stdout}\n${whisperHelp.stderr}`
      expect(whisperOutput).not.toContain('/opt/homebrew/')
      expect(whisperOutput).toContain(result.modelsDir)
      expect(existsSync(path.join(result.modelsDir, 'ggml-large-v3.bin'))).toBe(false)
    } finally {
      await app.cleanup()
    }
  })
})
