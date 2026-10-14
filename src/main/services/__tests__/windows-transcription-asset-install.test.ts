import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { setTimeout as delay } from 'timers/promises'

vi.mock('timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    copyFile: vi.fn(actual.copyFile),
    rm: vi.fn(actual.rm)
  }
})

import {
  installWindowsTranscriptionAsset,
  isWindowsAssetInstallIncomplete,
  WINDOWS_ASSET_INSTALL_MARKER
} from '../windows-transcription-asset-install'

let root: string
let staged: string
let target: string
const locked = () => Object.assign(new Error('Windows file is locked'), { code: 'EPERM' })

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'autodoc-asset-install-'))
  staged = join(root, 'staged')
  target = join(root, 'runtime')
  await fs.mkdir(join(staged, 'Lib'), { recursive: true })
  await fs.writeFile(join(staged, 'python.exe'), 'verified python')
  await fs.writeFile(join(staged, 'Lib', 'runtime.dll'), 'verified DLL')
})

afterEach(async () => {
  vi.mocked(fs.rename).mockReset()
  vi.mocked(fs.copyFile).mockReset()
  vi.mocked(fs.rm).mockReset()
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  vi.mocked(fs.rename).mockImplementation(actual.rename)
  vi.mocked(fs.copyFile).mockImplementation(actual.copyFile)
  vi.mocked(fs.rm).mockImplementation(actual.rm)
  vi.mocked(delay).mockClear()
  await actual.rm(root, { recursive: true, force: true })
})

describe('Windows transcription asset installation', () => {
  it('installs successfully even when Windows permanently denies directory rename', async () => {
    vi.mocked(fs.rename).mockRejectedValue(locked())
    const onRetry = vi.fn()
    await installWindowsTranscriptionAsset(staged, target, onRetry)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ code: 'EPERM', delayMs: 0 }))
    await expect(fs.readFile(join(target, 'python.exe'), 'utf8')).resolves.toBe('verified python')
    await expect(fs.readFile(join(target, 'Lib', 'runtime.dll'), 'utf8')).resolves.toBe(
      'verified DLL'
    )
    expect(await isWindowsAssetInstallIncomplete(target)).toBe(false)
    // The verified staging copy remains available to the caller for cleanup/retry.
    await expect(fs.access(join(staged, 'python.exe'))).resolves.toBeUndefined()
  })

  it('repairs an incomplete existing directory and retries only a temporarily locked file', async () => {
    await fs.mkdir(target)
    await fs.writeFile(join(target, 'python.exe'), 'old python')
    vi.mocked(fs.copyFile).mockRejectedValueOnce(locked())
    const onRetry = vi.fn()
    await installWindowsTranscriptionAsset(staged, target, onRetry)
    expect(fs.rename).not.toHaveBeenCalled()
    expect(delay).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ operation: 'copy file' }))
    await expect(fs.readFile(join(target, 'python.exe'), 'utf8')).resolves.toBe('verified python')
    expect(await isWindowsAssetInstallIncomplete(target)).toBe(false)
  })

  it('keeps verified files and marks a permanently blocked installation incomplete', async () => {
    await fs.mkdir(target)
    await fs.writeFile(join(target, 'python.exe'), 'old python')
    vi.mocked(fs.copyFile).mockRejectedValue(locked())
    await expect(installWindowsTranscriptionAsset(staged, target, vi.fn())).rejects.toThrow(
      'locked'
    )
    expect(delay).toHaveBeenCalledTimes(6)
    expect(fs.copyFile).toHaveBeenCalledTimes(7)
    expect(await isWindowsAssetInstallIncomplete(target)).toBe(true)
    await expect(fs.readFile(join(target, 'python.exe'), 'utf8')).resolves.toBe('old python')
    await expect(fs.readFile(join(staged, 'python.exe'), 'utf8')).resolves.toBe('verified python')

    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    vi.mocked(fs.copyFile).mockImplementation(actual.copyFile)
    await installWindowsTranscriptionAsset(staged, target, vi.fn())
    expect(await isWindowsAssetInstallIncomplete(target)).toBe(false)
    await expect(fs.readFile(join(target, 'python.exe'), 'utf8')).resolves.toBe('verified python')
  })

  it('retries completion publication without copying the runtime again', async () => {
    await fs.mkdir(target)
    vi.mocked(fs.rm).mockRejectedValueOnce(locked())
    await installWindowsTranscriptionAsset(staged, target, vi.fn())
    expect(fs.copyFile).toHaveBeenCalledTimes(2)
    expect(fs.rm).toHaveBeenCalledTimes(2)
    expect(await isWindowsAssetInstallIncomplete(target)).toBe(false)
  })

  it('does not retry disk-full failures or expose partial files as installed', async () => {
    await fs.mkdir(target)
    vi.mocked(fs.copyFile).mockRejectedValue(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    )
    await expect(installWindowsTranscriptionAsset(staged, target, vi.fn())).rejects.toThrow(
      'disk full'
    )
    expect(delay).not.toHaveBeenCalled()
    expect(await isWindowsAssetInstallIncomplete(target)).toBe(true)
    await expect(fs.access(join(target, WINDOWS_ASSET_INSTALL_MARKER))).resolves.toBeUndefined()
  })
})
