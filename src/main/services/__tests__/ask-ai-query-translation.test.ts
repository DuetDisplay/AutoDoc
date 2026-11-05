import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AskAiQueryTranslator, askAiTranslationTargets } from '../ask-ai-query-translation'
import { AskAiPassages } from '../ask-ai-passages'
import { buildConversationWriterInput } from '../ask-ai-conversation'
import type { IndexedMeeting } from '../meeting-index'
vi.mock('../crypto', () => ({
  decryptJSON: vi.fn(async () => {
    throw Error('No cache')
  }),
  encryptJSON: vi.fn(async () => undefined)
}))
vi.mock('../mac-processing-profile', async (original) => ({
  ...(await original<typeof import('../mac-processing-profile')>()),
  macUsesAskAiAppendFollowups: () => false
}))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
import { logAutodocEvent } from '../autodoc-log'
const phrase = 'TRADUCTION_CONFIDENTIELLE'
const good = () => Response.json({ message: { content: JSON.stringify({ fr: phrase }) } })
function setup() {
  const state = { canInfer: true, ready: true, model: 'selected-writer' }
  const translator = new AskAiQueryTranslator({
    baseUrl: () => 'http://localhost:1',
    model: () => state.model,
    numCtx: () => 8192,
    canInfer: () => state.canInfer,
    isReady: () => state.ready,
    waitReady: async () => {}
  })
  return { state, translator }
}
beforeEach(() => {
  vi.stubEnv('AUTODOC_ASK_AI_TOP_MATCH', '1')
  vi.stubEnv('AUTODOC_ASK_AI_QUERY_TRANSLATION', '1')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => good())
  )
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})
it('makes one request to the current selected writer at its normal context, with state-only logging', async () => {
  const { translator, state } = setup()
  state.model = 'profile-model'
  expect(await translator.translate('Which owner approved the budget?', ['fr'])).toEqual([
    { language: 'fr', text: phrase }
  ])
  expect(fetch).toHaveBeenCalledTimes(1)
  const request = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
  expect(request).toMatchObject({
    model: 'profile-model',
    stream: false,
    options: { num_ctx: 8192 }
  })
  const event = vi.mocked(logAutodocEvent).mock.calls.at(-1)![0]
  expect(event.context).toEqual({
    outcome: 'success',
    targetCount: 1,
    durationMs: expect.any(Number)
  })
  expect(JSON.stringify(event)).not.toContain(phrase)
  expect(JSON.stringify(event)).not.toContain('budget')
})
it.each(['flags off', 'capture/processing', 'not warmed'])(
  'makes no translation call when %s',
  async (mode) => {
    const { translator, state } = setup()
    expect(await translator.translate('Who owns the project?', ['fr'])).toHaveLength(1)
    vi.mocked(fetch).mockClear()
    if (mode === 'flags off') vi.stubEnv('AUTODOC_ASK_AI_TOP_MATCH', '0')
    if (mode === 'capture/processing') state.canInfer = false
    if (mode === 'not warmed') state.ready = false
    expect(await translator.translate('Who owns the project?', ['fr'])).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  }
)
it.each(['timeout', 'Stop', 'capture starts'])(
  'aborts on %s and falls back without failing the turn',
  async (mode) => {
    const { translator } = setup()
    expect(await translator.translate('Who owns the project?', ['fr'])).toHaveLength(1)
    vi.useFakeTimers()
    const parent = new AbortController()
    let observed: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: unknown, init: { signal: AbortSignal }) =>
          await new Promise((_resolve, reject) => {
            observed = init.signal
            observed!.addEventListener(
              'abort',
              () => reject(new DOMException('Cancelled', 'AbortError')),
              { once: true }
            )
          })
      )
    )
    const pending = translator.translate('Who owns the project?', ['fr'], parent.signal)
    await vi.waitFor(() => expect(observed).toBeDefined())
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(3000)
    if (mode === 'Stop') parent.abort()
    if (mode === 'capture starts') translator.cancelActive()
    expect(await pending).toEqual([])
    expect(observed!.aborted).toBe(true)
  }
)
it.each(['invalid JSON', 'missing language', 'extra language', 'HTTP error'])(
  'falls back on %s',
  async (mode) => {
    const { translator } = setup()
    expect(await translator.translate('Who owns the project?', ['fr'])).toHaveLength(1)
    const content =
      mode === 'invalid JSON'
        ? 'not json'
        : JSON.stringify(mode === 'missing language' ? {} : { fr: phrase, de: 'extra' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mode === 'HTTP error'
          ? new Response('', { status: 500 })
          : Response.json({ message: { content } })
      )
    )
    expect(await translator.translate('Who owns the project?', ['fr'])).toEqual([])
  }
)
function fixture(languages: string[]) {
  return languages.map((language, i) => ({
    meetingId: String(i),
    title: `Record ${i}`,
    date: 0,
    dir: '/unused',
    sourceName: null,
    signature: String(i),
    meetingLanguage: language,
    noteEntries: [
      {
        id: 'note',
        title: 'Overview',
        topic: null,
        content: `Owner reviewed budget deadline staffing risk entry ${i}.`,
        category: 'information',
        owner: null,
        deadline: null,
        sources: []
      }
    ],
    transcriptChunks: []
  })) as IndexedMeeting[]
}
it('targets at most six other languages by meeting count, never assuming unknown is English', () => {
  const meetings = fixture(['en', 'fr', 'fr', 'de', 'ja', 'es', 'it', 'nl', 'pt'])
  expect(askAiTranslationTargets('Which owner approved the project budget?', [], meetings)).toEqual(
    ['fr', 'de', 'es', 'it', 'ja', 'nl']
  )
  expect(
    askAiTranslationTargets('Which owner approved the project budget?', [], fixture(['en']))
  ).toEqual([])
  expect(
    askAiTranslationTargets('Which owner approved the project budget?', [], fixture(['unknown']))
  ).toEqual([])
  expect(askAiTranslationTargets('12345', [], meetings)).toEqual([])
})
it('keeps translation out of results, history and writer inputs; same-language scope and flag off make no call', async () => {
  const meetings = fixture(['en', 'fr']),
    translateQuery = vi.fn(async () => [{ language: 'fr', text: phrase }])
  const provider = {
    model: 'synthetic',
    isAvailable: async () => true,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
  }
  const index = new AskAiPassages(provider, '/unused', { translateQuery })
  const question = 'Which owner reviewed the project budget?'
  const result = await index.retrieveConversation(question, meetings, [])
  expect(translateQuery).toHaveBeenCalledTimes(1)
  const history: [] = []
  const input = buildConversationWriterInput(
    question,
    result!.excerpts!,
    { history, inventoryCount: 2 },
    8192,
    'Synthetic system'
  )
  expect(JSON.stringify({ result, input, history })).not.toContain(phrase)
  expect([
    ...(index as unknown as { queryVectors: Map<string, unknown> }).queryVectors.keys()
  ]).not.toContain(phrase)
  const scopedB = await index.retrieveConversation(question, meetings, [], [], ['0'])
  expect(translateQuery).toHaveBeenCalledTimes(1)
  vi.stubEnv('AUTODOC_ASK_AI_QUERY_TRANSLATION', '0')
  expect(JSON.stringify(await index.retrieveConversation(question, meetings, [], [], ['0']))).toBe(
    JSON.stringify(scopedB)
  )
  vi.stubEnv('AUTODOC_ASK_AI_QUERY_TRANSLATION', '1')
  translateQuery.mockResolvedValueOnce([])
  const fallback = await index.retrieveConversation(question, meetings, [])
  vi.stubEnv('AUTODOC_ASK_AI_QUERY_TRANSLATION', '0')
  expect(JSON.stringify(await index.retrieveConversation(question, meetings, []))).toBe(
    JSON.stringify(fallback)
  )
  vi.stubEnv('AUTODOC_ASK_AI_QUERY_TRANSLATION', '1')
  expect(translateQuery).toHaveBeenCalledTimes(2)
  vi.stubEnv('AUTODOC_ASK_AI_TOP_MATCH', '0')
  const baseline = await index.retrieveConversation(question, meetings, [])
  vi.stubEnv('AUTODOC_ASK_AI_QUERY_TRANSLATION', '0')
  expect(JSON.stringify(await index.retrieveConversation(question, meetings, []))).toBe(
    JSON.stringify(baseline)
  )
  expect(translateQuery).toHaveBeenCalledTimes(2)
})
