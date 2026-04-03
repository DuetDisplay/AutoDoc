import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockAccess = vi.fn()
const mockExecFile = vi.fn()
const mockShowMessageBox = vi.fn()
const mockRelaunch = vi.fn()
const mockQuit = vi.fn()
const mockMoveToApplicationsFolder = vi.fn()
const mockIsInApplicationsFolder = vi.fn()
const mockGetVersion = vi.fn()
const mockGetName = vi.fn()
const mockGetPath = vi.fn()

vi.mock('node:fs/promises', () => ({
  access: mockAccess,
}))

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    isInApplicationsFolder: mockIsInApplicationsFolder,
    getVersion: mockGetVersion,
    getName: mockGetName,
    getPath: mockGetPath,
    relaunch: mockRelaunch,
    quit: mockQuit,
    moveToApplicationsFolder: mockMoveToApplicationsFolder,
  },
  dialog: {
    showMessageBox: mockShowMessageBox,
  },
}))

async function loadModule() {
  vi.resetModules()
  return import('../application-install')
}

describe('application-install', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsInApplicationsFolder.mockReturnValue(false)
    mockGetVersion.mockReturnValue('0.1.5')
    mockGetName.mockReturnValue('AutoDoc')
    mockGetPath.mockImplementation((name: string) => {
      if (name === 'exe') {
        return '/Volumes/AutoDoc/AutoDoc.app/Contents/MacOS/AutoDoc'
      }
      throw new Error(`unexpected app.getPath(${name})`)
    })
    mockMoveToApplicationsFolder.mockReturnValue(true)
    mockShowMessageBox.mockResolvedValue({ response: 0 })
    mockAccess.mockResolvedValue(undefined)
    mockExecFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: '0.1.5\n', stderr: '' })
    })
  })

  it('skips enforcement outside macOS', async () => {
    const { enforceMacOSInstallLocation } = await loadModule()

    await expect(enforceMacOSInstallLocation('win32')).resolves.toBe(true)
    expect(mockShowMessageBox).not.toHaveBeenCalled()
    expect(mockMoveToApplicationsFolder).not.toHaveBeenCalled()
  })

  it('relaunches the Applications copy when the installed version matches', async () => {
    const { enforceMacOSInstallLocation } = await loadModule()

    await expect(enforceMacOSInstallLocation('darwin')).resolves.toBe(false)

    expect(mockRelaunch).toHaveBeenCalledWith({
      execPath: '/Applications/AutoDoc.app/Contents/MacOS/AutoDoc',
    })
    expect(mockQuit).toHaveBeenCalledTimes(1)
    expect(mockShowMessageBox).not.toHaveBeenCalled()
    expect(mockMoveToApplicationsFolder).not.toHaveBeenCalled()
  })

  it('prompts for an upgrade when the Applications copy is older', async () => {
    mockExecFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: '0.1.4\n', stderr: '' })
    })

    const { enforceMacOSInstallLocation } = await loadModule()

    await expect(enforceMacOSInstallLocation('darwin')).resolves.toBe(false)

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Upgrade Applications Copy',
      buttons: ['Upgrade in Applications', 'Quit'],
    }))
    expect(mockMoveToApplicationsFolder).toHaveBeenCalledWith(expect.objectContaining({
      conflictHandler: expect.any(Function),
    }))
  })

  it('quits when the user declines moving a loose copy into Applications', async () => {
    mockAccess.mockRejectedValue(new Error('missing'))
    mockShowMessageBox.mockResolvedValue({ response: 1 })

    const { enforceMacOSInstallLocation } = await loadModule()

    await expect(enforceMacOSInstallLocation('darwin')).resolves.toBe(false)

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Move AutoDoc to Applications',
      buttons: ['Move to Applications', 'Quit'],
    }))
    expect(mockQuit).toHaveBeenCalledTimes(1)
    expect(mockMoveToApplicationsFolder).not.toHaveBeenCalled()
  })

  it('compares dotted versions numerically', async () => {
    const { compareVersionStrings } = await loadModule()

    expect(compareVersionStrings('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersionStrings('1.2.0', '1.2')).toBe(0)
    expect(compareVersionStrings('0.9.9', '1.0.0')).toBe(-1)
  })
})
