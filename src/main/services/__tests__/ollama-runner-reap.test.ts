import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/autodoc-test'),
    isPackaged: false
  }
}))

const {
  formatWmicLlamaServerListing,
  getRunnerRecycleRssThresholdMiB,
  parseManagedLlamaServerPids,
  parseManagedLlamaServers,
  parseWindowsLlamaServerCimJson,
  selectBloatedLlamaServers
} = await import('../ollama-manager')

const DEV_RUNTIME = '/Users/chris/Library/Application Support/AutoDoc Dev/models/ollama-runtime'
const PROD_RUNTIME = '/Users/chris/Library/Application Support/AutoDoc/models/ollama-runtime'

describe('parseManagedLlamaServerPids', () => {
  it('kills only llama-server processes from this app runtime', () => {
    const listing = [
      `27809 ${DEV_RUNTIME}/llama-server --model qwen -c 4096`,
      `84972 ${DEV_RUNTIME}/llama-server --model qwen -c 8192`,
      `33028 ${PROD_RUNTIME}/llama-server --model qwen -c 4096`,
      '84357 /usr/bin/ollama serve'
    ].join('\n')

    expect(parseManagedLlamaServerPids(listing, DEV_RUNTIME)).toEqual([27809, 84972])
  })

  it('parses Windows wmic rows that put the pid at the end', () => {
    const runtime = 'C:\\Users\\chris\\AppData\\Roaming\\AutoDoc\\models\\ollama-runtime'
    const listing = [
      'ExecutablePath                      ProcessId',
      `${runtime}\\llama-server.exe        4412`
    ].join('\n')

    expect(parseManagedLlamaServerPids(listing, runtime)).toEqual([4412])
  })

  it('ignores empty listings and other runtimes', () => {
    expect(parseManagedLlamaServerPids('', DEV_RUNTIME)).toEqual([])
    expect(
      parseManagedLlamaServerPids(`33028 ${PROD_RUNTIME}/llama-server --model qwen`, DEV_RUNTIME)
    ).toEqual([])
  })

  it('reads working set and ctx-size from Windows CIM JSON', () => {
    const runtime = 'C:\\Users\\chris\\AppData\\Roaming\\AutoDoc Dev\\models\\ollama-runtime'
    const json = JSON.stringify({
      ProcessId: 4412,
      WorkingSetSize: 4120903680,
      ExecutablePath: `${runtime}\\llama-server.exe`,
      CommandLine: `"${runtime}\\llama-server.exe" --model qwen -c 8192`
    })

    expect(parseWindowsLlamaServerCimJson(json, runtime)).toEqual([
      { pid: 4412, rssMiB: 3930, numCtx: 8192 }
    ])
  })

  it('ignores CIM rows from a different AutoDoc runtime', () => {
    const runtime = 'C:\\Users\\chris\\AppData\\Roaming\\AutoDoc Dev\\models\\ollama-runtime'
    const json = JSON.stringify({
      ProcessId: 9001,
      WorkingSetSize: 4120903680,
      ExecutablePath: 'C:\\Users\\chris\\AppData\\Roaming\\AutoDoc\\models\\ollama-runtime\\llama-server.exe',
      CommandLine: 'C:\\Users\\chris\\AppData\\Roaming\\AutoDoc\\models\\ollama-runtime\\llama-server.exe -c 4096'
    })

    expect(parseWindowsLlamaServerCimJson(json, runtime)).toEqual([])
  })

  it('formats WMIC working-set rows into a pid rssKb command listing', () => {
    const runtime = 'C:\\Users\\chris\\AppData\\Roaming\\AutoDoc\\models\\ollama-runtime'
    const listing = [
      'ExecutablePath                      ProcessId  WorkingSetSize',
      `${runtime}\\llama-server.exe        4412       4120903680`
    ].join('\n')

    expect(parseManagedLlamaServers(formatWmicLlamaServerListing(listing), runtime)).toEqual([
      { pid: 4412, rssMiB: 3930, numCtx: null }
    ])
  })
})

describe('runner RSS recycle threshold', () => {
  const GIB = 1024 ** 3

  it('allows more runner growth on large-RAM Macs than small ones', () => {
    expect(getRunnerRecycleRssThresholdMiB(24 * GIB, 'darwin')).toBe(4864)
    expect(getRunnerRecycleRssThresholdMiB(16 * GIB, 'darwin')).toBe(4352)
    expect(getRunnerRecycleRssThresholdMiB(8 * GIB, 'darwin')).toBe(4352)
  })

  it('recycles earlier on 16 GB and 8 GB Windows hosts than on 24 GB', () => {
    expect(getRunnerRecycleRssThresholdMiB(32 * GIB, 'win32')).toBe(4864)
    expect(getRunnerRecycleRssThresholdMiB(16 * GIB, 'win32')).toBe(3584)
    expect(getRunnerRecycleRssThresholdMiB(8 * GIB, 'win32')).toBe(2560)
  })

  it('selects only runners with known rss above the threshold', () => {
    const fresh = { pid: 1, rssMiB: 3700, numCtx: 4096 }
    const bloated = { pid: 2, rssMiB: 5200, numCtx: 4096 }
    const unknownRss = { pid: 3, rssMiB: null, numCtx: 8192 }

    expect(selectBloatedLlamaServers([fresh, bloated, unknownRss], 4864)).toEqual([bloated])
    expect(selectBloatedLlamaServers([fresh, unknownRss], 4864)).toEqual([])
  })
})
