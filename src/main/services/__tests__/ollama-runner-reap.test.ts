import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/autodoc-test'),
    isPackaged: false
  }
}))

const {
  getRunnerRecycleRssThresholdMiB,
  parseManagedLlamaServerPids,
  parseManagedLlamaServers,
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

  it('reads context size and rss from a darwin process listing', () => {
    const listing = [
      `27809  3670016 ${DEV_RUNTIME}/llama-server --model qwen -c 4096`,
      `84972  4812800 ${DEV_RUNTIME}/llama-server --model qwen --ctx-size 8192`
    ].join('\n')

    expect(parseManagedLlamaServers(listing, DEV_RUNTIME)).toEqual([
      { pid: 27809, rssMiB: 3584, numCtx: 4096 },
      { pid: 84972, rssMiB: 4700, numCtx: 8192 }
    ])
  })
})

describe('runner RSS recycle threshold', () => {
  const GIB = 1024 ** 3

  it('allows more runner growth on large-RAM hosts than small ones', () => {
    expect(getRunnerRecycleRssThresholdMiB(24 * GIB)).toBe(4864)
    expect(getRunnerRecycleRssThresholdMiB(16 * GIB)).toBe(4352)
    expect(getRunnerRecycleRssThresholdMiB(8 * GIB)).toBe(4352)
  })

  it('selects only runners with known rss above the threshold', () => {
    const fresh = { pid: 1, rssMiB: 3700, numCtx: 4096 }
    const bloated = { pid: 2, rssMiB: 5200, numCtx: 4096 }
    const unknownRss = { pid: 3, rssMiB: null, numCtx: 8192 }

    expect(selectBloatedLlamaServers([fresh, bloated, unknownRss], 4864)).toEqual([bloated])
    expect(selectBloatedLlamaServers([fresh, unknownRss], 4864)).toEqual([])
  })
})
