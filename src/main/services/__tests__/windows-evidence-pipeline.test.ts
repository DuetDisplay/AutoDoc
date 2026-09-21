import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaProvider } from '../llm'
import { runNotesScanPipeline } from '../notes-scan-pipeline'

const platform = process.platform
afterEach(() => { vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', {value:platform, configurable:true}) })

describe('Windows evidence selection through the writer and presenter', () => {
  it('preserves qualifications verbatim without a rewrite or recovery call', async () => {
    Object.defineProperty(process,'platform',{value:'win32',configurable:true})
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER','evidence')
    const provider = new OllamaProvider('http://unused','qwen3:4b-instruct')
    const request = vi.spyOn(provider as any,'callOllama').mockResolvedValue(JSON.stringify({notes:[{t:'Inspection',s:1,e:1,k:'i'}]}))
    const text = 'Eighteen samples passed initial checks; six await reruns and are not confirmed failures.'
    const segments = await provider.summarize('source-test',`[00:00] [them] ${text}`)
    expect(segments.information.map(row => row.content)).toEqual([text])
    expect(request).toHaveBeenCalledTimes(1)
    const generate = vi.fn().mockRejectedValue(new Error('Unexpected extra model call'))
    const result = await runNotesScanPipeline(segments,{title:'Inspection',generate,spanSources:[{startMs:0,endMs:12000}],presentationMode:'lossless',meetingId:'source-test',attributionTranscript:[{id:'source',meetingId:'source-test',speaker:'them',text,startMs:0,endMs:12000,confidence:1}]})
    expect(result.content.sections.flatMap(section => [...section.keyPoints, ...section.supportingDetails]).map(row => row.text)).toContain(text)
    expect(generate).not.toHaveBeenCalled()
    expect(result.recoveredActionCount).toBe(0)
    expect(result.recoveredDecisionCount).toBe(0)
  })

  it('does not activate the selection prompt on macOS', () => {
    Object.defineProperty(process,'platform',{value:'darwin',configurable:true})
    const provider = new OllamaProvider('http://unused','qwen3:4b-instruct') as any
    const original = provider.getSystemPrompt()
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER','evidence')
    expect(provider.getSystemPrompt()).toBe(original)
  })
})
