import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockAccess = vi.fn()
const mockExecFile = vi.fn()
const mockSpawn = vi.fn()
const mockShowMessageBox = vi.fn()
const mockQuit = vi.fn()
const mockGetVersion = vi.fn()
const mockGetName = vi.fn()
const mockGetPath = vi.fn()
const mockUnref = vi.fn()

vi.mock('node:fs/promises', () => ({
  access: mockAccess,
}))

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: mockGetVersion,
    getName: mockGetName,
    getPath: mockGetPath,
    quit: mockQuit,
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
    mockGetVersion.mockReturnValue('0.1.5')
    mockGetName.mockReturnValue('AutoDoc')
    mockGetPath.mockImplementation((name: string) => {
      if (name === 'exe') {
        return '/Volumes/AutoDoc/AutoDoc.app/Contents/MacOS/AutoDoc'
      }
      throw new Error(`unexpected app.getPath(${name})`)
    })
    mockShowMessageBox.mockResolvedValue({ response: 0 })
    mockAccess.mockResolvedValue(undefined)
    mockSpawn.mockReturnValue({ unref: mockUnref })
    mockExecFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: '0.1.5\n', stderr: '' })
    })
  })

  it('skips enforcement outside supported platforms', async () => {
    const { enforceInstalledApplicationPolicy } = await loadModule()

    await expect(enforceInstalledApplicationPolicy('linux')).resolves.toBe(true)
    expect(mockShowMessageBox).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('allows a loose macOS copy to continue when the Applications version matches', async () => {
    const { enforceInstalledApplicationPolicy } = await loadModule()

    await expect(enforceInstalledApplicationPolicy('darwin')).resolves.toBe(true)

    expect(mockShowMessageBox).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockQuit).not.toHaveBeenCalled()
  })

  it('prompts for an upgrade when the Applications copy is older', async () => {
    mockExecFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: '0.1.4\n', stderr: '' })
    })

    const { enforceInstalledApplicationPolicy } = await loadModule()

    await expect(enforceInstalledApplicationPolicy('darwin')).resolves.toBe(false)

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Upgrade Applications Copy',
      buttons: ['Upgrade in Applications', 'Quit'],
    }))
    expect(mockSpawn).toHaveBeenCalledWith('/bin/sh', expect.any(Array), expect.objectContaining({
      detached: true,
      stdio: 'ignore',
    }))
    expect(mockQuit).toHaveBeenCalledTimes(1)
  })

  it('quits when the user declines replacing the Applications copy', async () => {
    mockAccess.mockRejectedValue(new Error('missing'))
    mockShowMessageBox.mockResolvedValue({ response: 1 })

    const { enforceInstalledApplicationPolicy } = await loadModule()

    await expect(enforceInstalledApplicationPolicy('darwin')).resolves.toBe(true)

    expect(mockShowMessageBox).not.toHaveBeenCalled()
    expect(mockQuit).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('quits when the user declines replacing a different installed macOS version', async () => {
    mockExecFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: '0.1.4\n', stderr: '' })
    })
    mockShowMessageBox.mockResolvedValue({ response: 1 })

    const { enforceInstalledApplicationPolicy } = await loadModule()

    await expect(enforceInstalledApplicationPolicy('darwin')).resolves.toBe(false)

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Upgrade Applications Copy',
      buttons: ['Upgrade in Applications', 'Quit'],
    }))
    expect(mockQuit).toHaveBeenCalledTimes(1)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('prompts for an upgrade when a different Windows install is found', async () => {
    mockGetPath.mockImplementation((name: string) => {
      if (name === 'exe') {
        return 'D:\\Builds\\AutoDoc\\autodoc.exe'
      }
      throw new Error(`unexpected app.getPath(${name})`)
    })
    mockExecFile.mockImplementation((command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (command === 'powershell.exe') {
        callback(null, {
          stdout: '{"DisplayVersion":"0.1.4","InstallLocation":"C:\\\\Users\\\\chris\\\\AppData\\\\Local\\\\Programs\\\\AutoDoc","DisplayIcon":"C:\\\\Users\\\\chris\\\\AppData\\\\Local\\\\Programs\\\\AutoDoc\\\\autodoc.exe,0"}',
          stderr: '',
        })
        return
      }
      callback(null, { stdout: '', stderr: '' })
    })

    const { enforceInstalledApplicationPolicy } = await loadModule()

    await expect(enforceInstalledApplicationPolicy('win32')).resolves.toBe(false)

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Upgrade Installed Copy',
      buttons: ['Upgrade Installed Copy', 'Quit'],
    }))
    expect(mockSpawn).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({
      detached: true,
      env: expect.objectContaining({
        AUTODOC_TERMINATE_PIDS: '',
        AUTODOC_WAIT_PIDS: String(process.pid),
      }),
      stdio: 'ignore',
    }))
    expect((mockSpawn.mock.calls[0]?.[1] as string[]).join(' ')).toContain('Wait-Process')
    expect(mockQuit).toHaveBeenCalledTimes(1)
  })

  it('prompts for a downgrade when a newer Windows install is found', async () => {
    mockGetVersion.mockReturnValue('0.1.4')
    mockGetPath.mockImplementation((name: string) => {
      if (name === 'exe') {
        return 'D:\\Builds\\AutoDoc\\autodoc.exe'
      }
      throw new Error(`unexpected app.getPath(${name})`)
    })
    mockExecFile.mockImplementation((command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (command === 'powershell.exe') {
        callback(null, {
          stdout: '{"DisplayVersion":"0.1.6","InstallLocation":"C:\\\\Users\\\\chris\\\\AppData\\\\Local\\\\Programs\\\\AutoDoc","DisplayIcon":"C:\\\\Users\\\\chris\\\\AppData\\\\Local\\\\Programs\\\\AutoDoc\\\\autodoc.exe,0"}',
          stderr: '',
        })
        return
      }
      callback(null, { stdout: '', stderr: '' })
    })

    const { enforceInstalledApplicationPolicy } = await loadModule()

    await expect(enforceInstalledApplicationPolicy('win32')).resolves.toBe(false)

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Downgrade Installed Copy',
      buttons: ['Downgrade Installed Copy', 'Quit'],
    }))
    expect(mockSpawn).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({
      detached: true,
      stdio: 'ignore',
    }))
    expect(mockQuit).toHaveBeenCalledTimes(1)
  })

  it('handles a Windows lock conflict by prompting from the launched loose copy', async () => {
    mockGetVersion.mockReturnValue('0.1.8')
    mockGetPath.mockImplementation((name: string) => {
      if (name === 'exe') {
        return 'D:\\Builds\\AutoDoc\\autodoc.exe'
      }
      throw new Error(`unexpected app.getPath(${name})`)
    })
    mockExecFile.mockImplementation((command: string, args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (command !== 'powershell.exe') {
        callback(null, { stdout: '', stderr: '' })
        return
      }

      const script = args[4] ?? ''
      if (script.includes('Get-ItemProperty')) {
        callback(null, {
          stdout: '{"DisplayVersion":"0.1.6","InstallLocation":"C:\\\\Users\\\\chris\\\\AppData\\\\Local\\\\Programs\\\\AutoDoc","DisplayIcon":"C:\\\\Users\\\\chris\\\\AppData\\\\Local\\\\Programs\\\\AutoDoc\\\\autodoc.exe,0"}',
          stderr: '',
        })
        return
      }

      if (script.includes('Get-CimInstance Win32_Process')) {
        callback(null, {
          stdout: '[4321,5678]',
          stderr: '',
        })
        return
      }

      callback(null, { stdout: '', stderr: '' })
    })

    const { handleSingleInstanceLockFailure } = await loadModule()

    await expect(handleSingleInstanceLockFailure('win32')).resolves.toBe(true)

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Upgrade Installed Copy',
      buttons: ['Upgrade Installed Copy', 'Quit'],
    }))
    expect(mockSpawn).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({
      detached: true,
      env: expect.objectContaining({
        AUTODOC_TERMINATE_PIDS: '4321,5678',
        AUTODOC_WAIT_PIDS: `${process.pid},4321,5678`,
      }),
      stdio: 'ignore',
    }))
    expect((mockSpawn.mock.calls[0]?.[1] as string[]).join(' ')).toContain('Stop-Process')
    expect((mockSpawn.mock.calls[0]?.[1] as string[]).join(' ')).toContain('Wait-Process')
    expect(mockQuit).toHaveBeenCalledTimes(1)
  })

  it('handles a second-instance launch from a different macOS version', async () => {
    mockGetPath.mockImplementation((name: string) => {
      if (name === 'exe') {
        return '/Applications/AutoDoc.app/Contents/MacOS/AutoDoc'
      }
      throw new Error(`unexpected app.getPath(${name})`)
    })
    mockGetVersion.mockReturnValue('0.1.5')
    mockExecFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: '0.1.5\n', stderr: '' })
    })

    const { handleSecondInstanceLaunch } = await loadModule()

    await expect(handleSecondInstanceLaunch({
      containerPath: '/Volumes/AutoDoc/AutoDoc.app',
      executablePath: '/Volumes/AutoDoc/AutoDoc.app/Contents/MacOS/AutoDoc',
      packaged: true,
      platform: 'darwin',
      version: '0.1.6',
    }, 'darwin')).resolves.toBe(true)

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Upgrade Applications Copy',
      buttons: ['Upgrade in Applications', 'Quit'],
    }))
    expect(mockSpawn).toHaveBeenCalledWith('/bin/sh', expect.any(Array), expect.objectContaining({
      detached: true,
      stdio: 'ignore',
    }))
    expect(mockQuit).toHaveBeenCalledTimes(1)
  })

  it('compares dotted versions numerically', async () => {
    const { compareVersionStrings } = await loadModule()

    expect(compareVersionStrings('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersionStrings('1.2.0', '1.2')).toBe(0)
    expect(compareVersionStrings('0.9.9', '1.0.0')).toBe(-1)
  })
})
