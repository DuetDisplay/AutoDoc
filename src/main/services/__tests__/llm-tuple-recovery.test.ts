import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractWriterCategoryObject, OllamaProvider, parseWriterJsonRecord } from '../llm'

vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
vi.mock('../sentry-reporter', () => ({ captureMessage: vi.fn() }))

const originalPlatform = process.platform
const fact = ['Rollout paused', 'The rollout is paused until the crash rate drops.', 21000, 21000]
const action = ['Send report', 'Alex will send the report tomorrow.', 31000, 31000, 'Alex']
const tuple = JSON.stringify(fact)
const task = JSON.stringify(action)

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.stubEnv('AUTODOC_TEST_NOTES_TIGHT', '')
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', '')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Windows category-local tuple recovery', () => {
  it.each(['}', '}}]', '', ',["unfinished', ',["unfinished","body",'])(
    'keeps a complete tuple before %j',
    (suffix) => {
      expect(extractWriterCategoryObject(`{"i":[${tuple}${suffix}`)).toEqual({ i: [fact] })
    }
  )

  it('continues through repeated broken categories without borrowing action tuples', () => {
    const raw = `{"i":[${tuple}},{"a":[${task}]},"i":[["Later","Later fact.",41000,42000]}}]`
    expect(extractWriterCategoryObject(raw)).toEqual({
      i: [fact, ['Later', 'Later fact.', 41000, 42000]],
      a: [action]
    })
  })

  it('does not skip a later occurrence after an unclosed first occurrence', () => {
    expect(extractWriterCategoryObject(`{"i":[${tuple}},"i":[${tuple}]}`)).toEqual({
      i: [fact, fact]
    })
  })

  it('does not duplicate complete tuples when an occurrence parses normally', () => {
    expect(extractWriterCategoryObject(`{"i":[${tuple}],"a":[${task}],"i":[${tuple}]}`)).toEqual({
      i: [fact, fact],
      a: [action]
    })
  })

  it('retains same-title distinct tuples in original category order', () => {
    const other = [fact[0], 'The rollout is now complete.', 51000, 51000]
    expect(extractWriterCategoryObject(`{"i":[${tuple},${JSON.stringify(other)}}`)).toEqual({
      i: [fact, other]
    })
  })

  it('preserves escaped quotes, backslashes, category names, and brackets inside strings', () => {
    const quoted = [
      'Example "a"',
      'The string "i":[["fake","fake",1,2]] and C:\\files\\[a] is data.',
      1,
      2
    ]
    expect(extractWriterCategoryObject(`{"i":[${JSON.stringify(quoted)}}`)).toEqual({ i: [quoted] })
  })

  it.each([
    '["unfinished',
    '["title",3,1,2]',
    '[["nested","body",1,2]]',
    '["bad","body",1e,2]',
    '{"c":"object"}'
  ])('stops at an invalid direct child %s', (child) => {
    const raw = `{"i":[${tuple},${child},${task}}`
    expect(extractWriterCategoryObject(raw)).toEqual({ i: [fact] })
  })

  it('continues to a later actual category after an invalid child', () => {
    expect(extractWriterCategoryObject(`{"i":[["bad",3]},"a":[${task}]}`)).toEqual({ a: [action] })
  })

  it('does not invent ownership for an unknown category or a bare tuple', () => {
    expect(extractWriterCategoryObject(`{"unknown":[${tuple}}`)).toBeNull()
    expect(extractWriterCategoryObject(tuple)).toBeNull()
  })

  it('normalizes only the integer spelling in a complete recovered tuple', () => {
    const raw = '{"i":[["ID 002","Preserve 0051000 in prose.",0021000,0051000,null,"002"]}}'
    expect(extractWriterCategoryObject(raw)).toEqual({
      i: [['ID 002', 'Preserve 0051000 in prose.', 21000, 51000, null, '002']]
    })
  })

  it.each(['darwin', 'linux'])('does not enable recovery on %s', (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    expect(extractWriterCategoryObject(`{"i":[${tuple}}`)).toBeNull()
    expect(extractWriterCategoryObject(`{"i":[${tuple}]}`)).toEqual({ i: [fact] })
  })

  it.each(['1', 'lines', 'catalog', 'whole', 'wide', 'semantic', 'outline', 'evidence'])(
    'does not enable recovery for the %s experiment',
    (mode) => {
      vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', mode)
      expect(extractWriterCategoryObject(`{"i":[${tuple}}`)).toBeNull()
      expect(extractWriterCategoryObject(`{"i":[${tuple}]}`)).toEqual({ i: [fact] })
    }
  )

  it('does not enable recovery when the tight writer is disabled', () => {
    vi.stubEnv('AUTODOC_TEST_NOTES_TIGHT', '0')
    expect(extractWriterCategoryObject(`{"i":[${tuple}}`)).toBeNull()
  })

  it('keeps valid Mac records intact and does not salvage incomplete object containers', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const note = { t: 'Rollout', h: 'Paused', c: fact[1], s: 7, e: 9 }
    expect(parseWriterJsonRecord(JSON.stringify({ information: [note] }))).toEqual({
      information: [note]
    })
    expect(extractWriterCategoryObject(`{"information":[${JSON.stringify(note)}}`)).toBeNull()
  })
})

describe('recovered tuples through generation', () => {
  const transcript =
    '[00:21] The rollout is paused until the crash rate drops.\n[00:31] Alex will send the report tomorrow.'
  const stream = (raw: string) =>
    new Response(
      raw
        .match(/[\s\S]{1,13}/g)!
        .map((content, index, parts) =>
          JSON.stringify({ message: { content }, done: index === parts.length - 1 })
        )
        .join('\n') + '\n'
    )

  it('preserves categories and citations through the real stream reader without a retry', async () => {
    const fetch = vi.fn(async () => stream(`{"i":[${tuple}},"a":[${task}}`))
    vi.stubGlobal('fetch', fetch)
    const provider = new OllamaProvider('http://localhost:11435', 'test-model')
    const notes = await provider.summarize('tuple-recovery', transcript, undefined, 1)
    expect(notes.information).toHaveLength(1)
    expect(notes.actionItems).toHaveLength(1)
    expect(notes.information[0]).toMatchObject({
      content: fact[1],
      sourceStartMs: 21000,
      sourceEndMs: 21000
    })
    expect(notes.actionItems[0]).toMatchObject({ content: action[1], assignee: 'Alex' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(provider.getLastWriterSkips()).toEqual([])
  })

  it('retains the existing bounded retry for a response with no complete recoverable tuple', async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => stream('{"i":[["unfinished'))
      .mockImplementationOnce(async () => stream(`{"i":[${tuple}]}`))
    vi.stubGlobal('fetch', fetch)
    const provider = new OllamaProvider('http://localhost:11435', 'test-model')
    const notes = await provider.summarize('tuple-recovery', transcript, undefined, 1)
    expect(notes.information).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry a valid response merely because its claims are rejected', async () => {
    const fetch = vi.fn(async () =>
      stream('{"i":[["Revenue","Revenue increased by 99%.",21000,21000]]}')
    )
    vi.stubGlobal('fetch', fetch)
    const provider = new OllamaProvider('http://localhost:11435', 'test-model')
    const notes = await provider.summarize('tuple-recovery', transcript, undefined, 1)
    expect(Object.values(notes).flat()).toHaveLength(0)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('preserves a previously available parse-error retry when recovered candidates are all rejected', async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream('{"i":[["Revenue","Revenue increased by 99%.",21000,21000]}}]')
      )
      .mockImplementationOnce(async () => stream(`{"i":[${tuple}]}`))
    vi.stubGlobal('fetch', fetch)
    const provider = new OllamaProvider('http://localhost:11435', 'test-model')
    const notes = await provider.summarize('tuple-recovery', transcript, undefined, 1)
    expect(notes.information).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(provider.getLastWriterSkips()).toEqual([])
  })

  it('does not add retries when the old partial parser already returned rejected candidates', async () => {
    const bad = '["Revenue","Revenue increased by 99%.",21000,21000]'
    const fetch = vi.fn(async () => stream(`{"i":[${bad}}],"a":[${bad}]}`))
    vi.stubGlobal('fetch', fetch)
    const provider = new OllamaProvider('http://localhost:11435', 'test-model')
    const notes = await provider.summarize('tuple-recovery', transcript, undefined, 1)
    expect(Object.values(notes).flat()).toHaveLength(0)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps the existing one-retry limit when every malformed attempt recovers only rejected claims', async () => {
    const fetch = vi.fn(async () =>
      stream('{"i":[["Revenue","Revenue increased by 99%.",21000,21000]}}]')
    )
    vi.stubGlobal('fetch', fetch)
    const provider = new OllamaProvider('http://localhost:11435', 'test-model')
    const notes = await provider.summarize('tuple-recovery', transcript, undefined, 1)
    expect(Object.values(notes).flat()).toHaveLength(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(provider.getLastWriterSkips()).toHaveLength(1)
  })
})
