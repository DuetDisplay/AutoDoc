import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/autodoc-test'),
    isPackaged: false
  }
}))

const { parseManagedLlamaServerPids } = await import('../ollama-manager')

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
})
