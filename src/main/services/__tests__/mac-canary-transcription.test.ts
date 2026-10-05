import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { resolveMacCanaryTranscriber } from '../mac-canary-transcription'

const state = vi.hoisted(() => ({ packaged: false, files: new Set<string>() }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged
    },
    getAppPath: () => '/repo',
    getPath: () => '/user'
  }
}))
vi.mock('fs', () => ({ existsSync: (path: string) => state.files.has(path) }))

beforeEach(() => {
  state.files.clear()
  state.packaged = false
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
  vi.stubEnv('AUTODOC_MAC_CANARY_PYTHON', '')
  vi.stubEnv('AUTODOC_MAC_CANARY_CACHE_DIR', '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Canary runtime resolution', () => {
  it('resolves the separate runtime and bridge in a packaged app', () => {
    state.packaged = true
    const root = process.resourcesPath ?? '/repo'
    const python = join(root, 'canary-mlx-runtime/darwin-arm64/python/bin/python3')
    state.files.add(python)
    state.files.add(join(root, 'canary-mlx-transcribe.py'))
    expect(resolveMacCanaryTranscriber()?.pythonPath).toBe(python)
    expect(resolveMacCanaryTranscriber()?.env.HF_HOME).toBe('/user/models/canary-mlx-cache')
  })
  it('keeps development Python and cache overrides', () => {
    vi.stubEnv('AUTODOC_MAC_CANARY_PYTHON', '/custom/python3')
    vi.stubEnv('AUTODOC_MAC_CANARY_CACHE_DIR', '/custom/cache')
    state.files.add('/custom/python3')
    state.files.add('/repo/resources/canary-mlx-transcribe.py')
    expect(resolveMacCanaryTranscriber()?.pythonPath).toBe('/custom/python3')
    expect(resolveMacCanaryTranscriber()?.env.HF_HOME).toBe('/custom/cache')
  })
  it('does not use a benchmark runtime to hide a missing packaged runtime', () => {
    state.packaged = true
    state.files.add('/repo/.benchmarks/canary-mlx14-runtime/python/bin/python3')
    expect(resolveMacCanaryTranscriber()).toBeNull()
  })
})
