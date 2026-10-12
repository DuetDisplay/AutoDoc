import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
vi.mock('util', () => ({ promisify: () => query }))
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  vi.resetModules()
  query.mockReset()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})
afterEach(() => Object.defineProperty(process, 'platform', platformDescriptor))

describe('installed Windows physical memory', () => {
  it('preserves capacities below the minimum instead of rounding them up', async () => {
    const { parseWindowsInstalledMemoryGiB } = await import('../windows-transcription-runtime')
    expect(parseWindowsInstalledMemoryGiB({ Capacity: 16 * 1024 ** 3 - 1 })).toBeLessThan(16)
    expect(parseWindowsInstalledMemoryGiB({ Capacity: 16 * 1024 ** 3 })).toBe(16)
  })

  it('sums actual CIM module capacities and caches the query across concurrent/status requests', async () => {
    query.mockResolvedValue({ stdout: '[{"Capacity":8589934592},{"Capacity":8589934592}]' })
    const { getWindowsInstalledMemoryGiB } = await import('../windows-transcription-runtime')
    expect(
      await Promise.all([getWindowsInstalledMemoryGiB(), getWindowsInstalledMemoryGiB()])
    ).toEqual([16, 16])
    expect(await getWindowsInstalledMemoryGiB()).toBe(16)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(
      'powershell',
      expect.arrayContaining([expect.stringContaining('Win32_PhysicalMemory -ErrorAction Stop')]),
      { timeout: 5000, windowsHide: true }
    )
  })

  it.each(['', 'not-json', '[]', '{"Capacity":null}', '[{"Capacity":8589934592},{}]'])(
    'returns unknown for incomplete/malformed detection: %s',
    async (stdout) => {
      query.mockResolvedValue({ stdout })
      const { getWindowsInstalledMemoryGiB } = await import('../windows-transcription-runtime')
      expect(await getWindowsInstalledMemoryGiB()).toBeNull()
    }
  )

  it('returns explicit unknown on query failure instead of OS-usable RAM', async () => {
    query.mockRejectedValue(new Error('CIM access denied or timeout'))
    const { getWindowsInstalledMemoryGiB } = await import('../windows-transcription-runtime')
    expect(await getWindowsInstalledMemoryGiB()).toBeNull()
    expect(await getWindowsInstalledMemoryGiB()).toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('does not query or change memory detection on Macs', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { getWindowsInstalledMemoryGiB } = await import('../windows-transcription-runtime')
    expect(await getWindowsInstalledMemoryGiB()).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })
})
