import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaProvider, WriterParseError } from '../llm'

const mocks = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: mocks.log }))
vi.mock('../sentry-reporter', () => ({ captureMessage: vi.fn() }))
const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function setup(os: NodeJS.Platform, mode: string, flag: string) {
  Object.defineProperty(process, 'platform', { configurable: true, value: os })
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', mode)
  vi.stubEnv('AUTODOC_TEST_NOTES_FAIL_FAST', flag)
  vi.stubEnv('AUTODOC_TEST_NOTES_CAPTURE_DIR', '')
  const provider = new OllamaProvider('http://localhost:11435', 'test-model')
  const chunks = ['[00:00] A proposal was discussed.', '[00:05] The proposal was rejected.']
  vi.spyOn(provider as any, 'chunkTranscript').mockReturnValue(chunks)
  const call = vi.spyOn(provider as any, 'callOllama').mockResolvedValue('invalid writer response')
  // Exercise the real summarize error path independently of a particular wire format.
  vi.spyOn(provider as any, 'parseResponseWithStats').mockImplementation(() => { throw new WriterParseError('invalid writer response') })
  return { provider, call, transcript: chunks.join('\n') }
}

describe('Windows experiment writer fail-fast', () => {
  it('throws on the first parser failure before retrying, skipping or completing the aggregate', async () => {
    const { provider, call, transcript } = setup('win32', 'evidence', '1')
    await expect(provider.summarize('fail-fast', transcript)).rejects.toBeInstanceOf(WriterParseError)
    expect(call).toHaveBeenCalledTimes(1)
    expect(provider.getLastWriterSkips()).toEqual([])
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({
      message: 'notes experiment stopped early',
      context: { reason: 'writer_parse', chunkIndex: 1, chunkCount: 2 }
    }))
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'notes llm summarize completed' }))
  })

  it.each([
    ['win32', 'evidence', '0'],
    ['win32', '0', '1'],
    ['darwin', 'evidence', '1'],
    ['linux', 'evidence', '1']
  ] as const)('preserves retry and skip behavior on %s with mode %s and flag %s', async (os, mode, flag) => {
    const { provider, call, transcript } = setup(os, mode, flag)
    await expect(provider.summarize('ordinary-retry', transcript)).resolves.toEqual({
      decisions: [], actionItems: [], information: [], discussion: [], statusUpdates: []
    })
    expect(call).toHaveBeenCalledTimes(4)
    expect(provider.getLastWriterSkips()).toHaveLength(2)
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'notes experiment stopped early' }))
  })

  it('does not turn unrelated request errors into parser failures', async () => {
    const { provider, call, transcript } = setup('win32', 'evidence', '1')
    call.mockRejectedValue(new Error('HTTP 500 generic request failure'))
    await expect(provider.summarize('request-error', transcript)).rejects.toThrow('HTTP 500 generic request failure')
    expect(call).toHaveBeenCalledTimes(3)
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'notes experiment stopped early' }))
  })
})
