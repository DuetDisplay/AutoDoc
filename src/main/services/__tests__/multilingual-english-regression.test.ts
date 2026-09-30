import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaProvider, WRITER_EXAMPLE_VALUE_REPLACEMENTS } from '../llm'
import { generateNotesOverview, OVERVIEW_EXAMPLE_VALUE_REPLACEMENTS } from '../notes-overview'
import { runWithMeetingLanguage } from '../notes-language'

vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))
vi.mock('../sentry-reporter', () => ({ captureMessage: vi.fn() }))

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

afterEach(() => {
  vi.unstubAllGlobals()
  setPlatform(originalPlatform)
})

// Long enough for several writer chunks, so continuation prompts are covered.
const TRANSCRIPT = Array.from({ length: 90 }, (_, index) => {
  const seconds = index * 20
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const speaker = index % 2 === 0 ? 'me' : 'them'
  return `[${clock}] [${speaker}] Item ${index}: we agreed to move the billing portal launch to Friday and Dana will send the 12 percent pricing update.`
}).join('\n')

const EMPTY_WRITER_RESPONSE =
  '{"decisions":[],"action_items":[],"information":[],"discussion":[],"status_updates":[]}'

function streamedContent(content: string): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content } })}\n`))
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ done: true, done_reason: 'stop' })}\n`)
        )
        controller.close()
      }
    }),
    { status: 200 }
  )
}

async function captureWriterBodies(platform: NodeJS.Platform): Promise<string[]> {
  setPlatform(platform)
  const bodies: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return streamedContent(EMPTY_WRITER_RESPONSE)
    })
  )
  const provider = new OllamaProvider('http://localhost:11434', 'qwen3:4b-instruct')
  // Pin the context profile so the hash does not depend on this machine's memory.
  if (platform === 'win32') provider.setLowMemoryMode(true)
  await provider.summarize('meeting-english', TRANSCRIPT, undefined, 30)
  return bodies
}

async function captureOverviewRequests(): Promise<string[]> {
  const requests: string[] = []
  const generate = async (request: unknown): Promise<string> => {
    requests.push(JSON.stringify(request))
    return '{"overview":"The billing portal launch moved to Friday.","keyTakeaways":["Launch moved to Friday"]}'
  }
  const catalog =
    '## Billing Portal\n- The billing portal launch moved to Friday.\n- Dana will send the 12 percent pricing update.'
  const sources = [{ startMs: 0, endMs: 60_000 }]
  await generateNotesOverview(catalog, generate, sources, { numCtx: 4096 })
  await generateNotesOverview(catalog, generate, sources, { overviewOnly: true })
  return requests
}

function sha256(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n---\n')).digest('hex')
}

// Golden hashes were captured on main before AD-100. If one changes, English
// notes requests changed: fix the regression, never update the hash.
const MAIN_MAC_WRITER_SHA256 = 'd811db874cf35bd4f40e2b05f9e3c528405a0e680c828e00ddfef6793d40bcb9'
const MAIN_WINDOWS_WRITER_SHA256 =
  '9442401771a6584d5e83a6232df833d377e2aeb0d9b0bbd888ce34959ae24cea'
const MAIN_OVERVIEW_SHA256 = '1796d053e93f95c9c67ec0f9b3b9542d89f6459623682843916d2a6c6fa27e29'

describe('English notes requests are byte-identical to main', () => {
  it.each([
    ['darwin', MAIN_MAC_WRITER_SHA256],
    ['win32', MAIN_WINDOWS_WRITER_SHA256]
  ] as const)('keeps %s writer prompts and model options unchanged', async (platform, golden) => {
    const unscoped = await captureWriterBodies(platform)
    const english = await runWithMeetingLanguage('en', () => captureWriterBodies(platform))
    const legacy = await runWithMeetingLanguage(undefined, () => captureWriterBodies(platform))

    expect(unscoped.length).toBeGreaterThan(1)
    expect(sha256(unscoped)).toBe(golden)
    expect(english).toEqual(unscoped)
    expect(legacy).toEqual(unscoped)
  })

  it('keeps overview prompts and options unchanged', async () => {
    const unscoped = await captureOverviewRequests()
    const english = await runWithMeetingLanguage('en', () => captureOverviewRequests())

    expect(sha256(unscoped)).toBe(MAIN_OVERVIEW_SHA256)
    expect(english).toEqual(unscoped)
  })
})

describe('non-English notes requests', () => {
  it.each(['darwin', 'win32'] as const)(
    'end every %s writer request with the named German directive and no English example values',
    async (platform) => {
      const english = await captureWriterBodies(platform)
      const german = await runWithMeetingLanguage('de', () => captureWriterBodies(platform))

      expect(german).toHaveLength(english.length)
      for (const [index, raw] of german.entries()) {
        const body = JSON.parse(raw)
        const englishBody = JSON.parse(english[index]!)
        const system = body.messages[0].content as string
        const user = body.messages[1].content as string
        expect(user.endsWith('Do not translate names, product names or technical terms.')).toBe(
          true
        )
        expect(user).toContain('The transcript is in German. Write the entire response in German')
        expect(user).not.toMatch(/\bde\b/)
        expect(system).not.toContain('broad theme')
        expect(system).not.toContain('One sentence from this section.')
        // Same stages, model, and options; only prompt text differs.
        expect(body.model).toBe(englishBody.model)
        expect(body.options).toEqual(englishBody.options)
        expect(body.format).toEqual(englishBody.format)
      }
    }
  )

  it('raises overview output caps off English so structured output is not cut off', async () => {
    const english = (await captureOverviewRequests()).map((raw) => JSON.parse(raw).num_predict)
    const japanese = (await runWithMeetingLanguage('ja', () => captureOverviewRequests())).map(
      (raw) => JSON.parse(raw).num_predict
    )

    expect(english).toEqual([400, 256])
    expect(japanese).toEqual([1200, 768])
  })

  it('blanks overview example values only off English', async () => {
    const german = await runWithMeetingLanguage('bg', () => captureOverviewRequests())
    const prompts = german.map((raw) => JSON.parse(raw).prompt as string)

    expect(
      prompts.some((prompt) => prompt.includes('{"overview":"","keyTakeaways":["",""]}'))
    ).toBe(true)
    expect(prompts.some((prompt) => prompt.includes('{"overview":""}'))).toBe(true)
    expect(prompts.join('\n')).not.toContain('concise meeting summary')
  })

  it('matches every English example value it blanks', async () => {
    const macBody = JSON.parse((await captureWriterBodies('darwin'))[0]!)
    const windowsBody = JSON.parse((await captureWriterBodies('win32'))[0]!)
    const overviewPrompts = (await captureOverviewRequests()).map((raw) => JSON.parse(raw).prompt)

    expect(macBody.messages[0].content).toContain(WRITER_EXAMPLE_VALUE_REPLACEMENTS[0]![0])
    expect(windowsBody.messages[0].content).toContain(WRITER_EXAMPLE_VALUE_REPLACEMENTS[1]![0])
    for (const [english] of OVERVIEW_EXAMPLE_VALUE_REPLACEMENTS) {
      expect(overviewPrompts.some((prompt: string) => prompt.includes(english))).toBe(true)
    }
  })
})
