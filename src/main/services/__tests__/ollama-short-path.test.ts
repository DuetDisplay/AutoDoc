import { execFile } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveWindowsShortPath } from '../ollama-models-dir'

vi.mock('child_process', () => ({ execFile: vi.fn() }))

const SHORT_PATH = 'C:\\Users\\TEST~1\\AutoDoc\\OLLAMA~1\\'
const execFileMock = vi.mocked(execFile)

function respond(error: Error | null, stdout = ''): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void
    callback(error, stdout, '')
    return {} as ReturnType<typeof execFile>
  })
}

describe('resolveWindowsShortPath directory query', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    respond(null, `${SHORT_PATH}\r\n`)
  })

  it.each([
    [String.raw`C:\Users\Testł\AutoDoc\ollama-data`, 'C:\\Users\\Testł\\AutoDoc\\ollama-data\\'],
    ['C:/Users/Testł/AutoDoc/../AutoDoc/ollama-data', 'C:\\Users\\Testł\\AutoDoc\\ollama-data\\'],
    ['C:\\Users\\Testł\\AutoDoc\\ollama-data\\', 'C:\\Users\\Testł\\AutoDoc\\ollama-data\\'],
    ['C:\\', 'C:\\'],
    ['\\\\server\\share\\Testł\\ollama-data', '\\\\server\\share\\Testł\\ollama-data\\'],
    [
      String.raw`C:\Users\Testł & team (QA) %name%!\ollama-data`,
      'C:\\Users\\Testł & team (QA) %name%!\\ollama-data\\'
    ]
  ])('queries normalized directory %s with a trailing separator', async (input, expected) => {
    expect(await resolveWindowsShortPath(input)).toBe(SHORT_PATH)
    // Assert only safe projections: a failed assertion must not dump process.env.
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [command, args, options] = execFileMock.mock.calls[0]
    const settings = options as {
      env: Record<string, string | undefined>
      timeout: number
      windowsHide: boolean
      windowsVerbatimArguments: boolean
    }
    expect(command).toBe(process.env.ComSpec ?? 'cmd.exe')
    expect(args).toEqual([
      '/d',
      '/s',
      '/c',
      '"for %I in ("%AUTODOC_SHORT_PATH_TARGET%") do @echo %~sI"'
    ])
    expect(settings.env.AUTODOC_SHORT_PATH_TARGET).toBe(expected)
    expect(settings.timeout).toBe(2_000)
    expect(settings.windowsHide).toBe(true)
    expect(settings.windowsVerbatimArguments).toBe(true)
  })

  it('returns null when the command fails', async () => {
    respond(new Error('cmd failed'))
    expect(await resolveWindowsShortPath('C:\\Users\\Testł\\models')).toBeNull()
  })

  it('returns null for an empty command response', async () => {
    respond(null, '\r\n')
    expect(await resolveWindowsShortPath('C:\\Users\\Testł\\models')).toBeNull()
  })
})
