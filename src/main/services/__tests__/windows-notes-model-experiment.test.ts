import { afterEach, expect, it, vi } from 'vitest'
import { windowsNotesModelExperiment } from '../windows-notes-model-experiment'
import { OllamaProvider } from '../llm'
const platform = process.platform
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); Object.defineProperty(process, 'platform', { configurable: true, value: platform }) })

it('requires Windows, the explicit experiment flag and the selected model', () => {
  expect(windowsNotesModelExperiment('qwen3.5:4b', 'win32', '1')?.think).toBe(false)
  for (const os of ['darwin', 'linux'] as const) expect(windowsNotesModelExperiment('qwen3.5:4b', os, '1')).toBeNull()
  expect(windowsNotesModelExperiment('qwen3.5:4b', 'win32', '0')).toBeNull()
  expect(windowsNotesModelExperiment('qwen3:4b-instruct', 'win32', '1')).toBeNull()
})

it('uses constrained non-thinking generation for writer and overview while preserving CPU placement and caps', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv('AUTODOC_TEST_NOTES_QWEN35', '1')
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({message:{content:'{}'},response:'{}',done:true}) + '\n'))
  const provider = new OllamaProvider('http://localhost:11435', 'qwen3.5:4b')
  provider.setVramConstrainedContext(true, 'windows-cpu')
  await (provider as any).callOllama('A meeting excerpt.', 4096)
  await provider.completePrompt('A grounded catalog.', {num_ctx:4096,num_predict:256,temperature:0,seed:42})
  expect(fetchMock).toHaveBeenCalledTimes(2)
  for (const [url,request] of fetchMock.mock.calls) {
    expect(String(url)).toBe('http://localhost:11435/api/generate')
    const body = JSON.parse(String(request?.body))
    expect(body.think).toBe(false)
    expect(body.options).toMatchObject({num_ctx:4096,num_gpu:0,temperature:0.7,seed:42,repeat_penalty:1,presence_penalty:1.5})
    expect(body.options.num_predict).toBeLessThanOrEqual(768)
  }
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({prompt:expect.stringContaining('A meeting excerpt.'),system:expect.any(String)})
})

it('keeps the ordinary writer chat request unchanged when the experiment is disabled', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv('AUTODOC_TEST_NOTES_QWEN35', '0')
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({message:{content:'{}'},done:true}) + '\n'))
  const provider = new OllamaProvider('http://localhost:11435', 'qwen3.5:4b')
  await (provider as any).callOllama('A meeting excerpt.', 4096)
  const [url,request] = fetchMock.mock.calls[0]!
  expect(String(url)).toBe('http://localhost:11435/api/chat')
  const body = JSON.parse(String(request?.body))
  expect(body.think).toBeUndefined()
  expect(body.messages).toHaveLength(2)
  expect(body.options.temperature).toBe(0)
})
