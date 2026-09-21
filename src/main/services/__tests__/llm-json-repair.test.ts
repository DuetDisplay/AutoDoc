import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeMacNotesLineReferences,
  inspectCompactWriterPayload,
  OllamaProvider,
  parseWriterJsonRecord,
  repairJsonLeadingZeroIntegers
} from '../llm'

const mocks = vi.hoisted(() => ({ logAutodocEvent: vi.fn() }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: mocks.logAutodocEvent }))
vi.mock('../sentry-reporter', () => ({ captureMessage: vi.fn() }))

const originalPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('leading-zero JSON repair', () => {
  it.each([
    ['0021000', '21000'],
    ['0051000', '51000'],
    ['0017000', '17000'],
    ['002000', '2000'],
    ['00', '0'],
    ['000', '0'],
    ['-002', '-2'],
    ['-000', '-0']
  ])('normalizes the complete integer token %s', (token, expected) => {
    for (const [prefix, suffix] of [
      ['', ''],
      ['[', ']'],
      ['{"n":', '}'],
      ['[1,\n', ',2]']
    ]) {
      const repaired = repairJsonLeadingZeroIntegers(prefix + token + suffix)
      expect(repaired).toEqual({ json: prefix + expected + suffix, replacedCount: 1 })
      expect(() => JSON.parse(repaired.json)).not.toThrow()
      expect(repairJsonLeadingZeroIntegers(repaired.json)).toEqual({
        json: repaired.json,
        replacedCount: 0
      })
    }
  })

  it.each([
    '0',
    '21000',
    '-2',
    '-0',
    '0.05',
    '1.0002',
    '-0.002',
    '1e10',
    '1e002',
    '1E-002',
    '00.5',
    '01e2',
    '-01E-2',
    '+002',
    '--002',
    '1-002',
    'x002',
    '002x',
    '0x002',
    '.002'
  ])('leaves valid numbers and unsupported token shapes unchanged: %s', (token) => {
    const raw = `{"n":${token}}`
    expect(repairJsonLeadingZeroIntegers(raw)).toEqual({ json: raw, replacedCount: 0 })
  })

  it('preserves quoted numbers, escaped quotes, backslashes, and partial strings', () => {
    const text = 'Version "002" uses \\paths\\ and [0021000, -002].'
    const prefix = `{"i":[[${JSON.stringify(text)},"0021000",`
    const raw = `${prefix}0021000,0051000]]}`
    const repaired = repairJsonLeadingZeroIntegers(raw)
    expect(repaired).toEqual({ json: `${prefix}21000,51000]]}`, replacedCount: 2 })
    expect(JSON.parse(repaired.json).i[0].slice(0, 2)).toEqual([text, '0021000'])
    for (const partial of ['{"c":"001', '{"c":"escaped \\"002']) {
      expect(repairJsonLeadingZeroIntegers(partial).json).toBe(partial)
    }
  })

  it('repairs incident-shaped syntax without decoding clocks or losing duplicate categories', () => {
    const raw =
      '{"i":[["First","First fact.",0021000,0051000]],"i"[["Second","Second fact.",0017000,0021000]]}'
    const result = inspectCompactWriterPayload(
      parseWriterJsonRecord(repairJsonLeadingZeroIntegers(raw).json)!
    )
    expect(
      result.expanded.information?.map((item) => [item.sourceStartMs, item.sourceEndMs])
    ).toEqual([
      [21000, 51000],
      [17000, 21000]
    ])
  })
})

describe('repaired writer output through existing validation', () => {
  const supported = [
    'Rollout paused',
    'The rollout is paused until the crash rate drops.',
    21000,
    21000
  ]
  const unsupported = ['Trial starts improved 99%', 'Trial starts improved 99%.', 51000, 51000]
  const transcript = [
    { startMs: 21000, text: 'The rollout is paused until the crash rate drops.' },
    { startMs: 51000, text: 'Trial starts improved twelve percent.' }
  ]
  const valid = JSON.stringify({ i: [supported, unsupported] })
  const padded = valid.replaceAll(',21000', ',0021000').replaceAll(',51000', ',0051000')

  function parse(raw: string) {
    const provider = new OllamaProvider('http://localhost:11435', 'test-model')
    return provider.parseResponse(
      'meeting-repair',
      raw,
      undefined,
      60000,
      [21000, 51000],
      transcript
    )
  }

  it('keeps the supported note and citation identical while rejecting the unsupported claim', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const baseline = parse(valid)
    const repaired = parse(padded)
    expect(repaired).toEqual(baseline)
    expect(repaired.information).toHaveLength(1)
    expect(repaired.information[0]).toMatchObject({
      title: supported[0],
      content: supported[1],
      sourceStartMs: 21000,
      sourceEndMs: 21000
    })
    const repairs = mocks.logAutodocEvent.mock.calls.filter(
      ([event]) => event.message === 'notes llm json leading-zero repair'
    )
    expect(repairs).toEqual([
      [
        expect.objectContaining({
          meetingId: 'meeting-repair',
          context: { replacedCount: 4, rawHead: padded.slice(0, 400), rawTail: padded.slice(-400) }
        })
      ]
    ])
  })

  it('preserves existing recovery of complete tuples in a truncated category', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const raw = `{"i":[${JSON.stringify(supported)},["unfinished`
    expect(parse(raw.replaceAll(',21000', ',0021000'))).toEqual(parse(raw))
    expect(parse(raw).information).toHaveLength(1)
  })

  it('recovers complete tuples despite broken category closers without accepting unsupported content', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const raw = `{"a":[["broken","broken",0021000,0051000]},"i":[${JSON.stringify(supported)}]}`
    expect(parse(raw).information).toHaveLength(1)
    // This used to throw on the container. Its complete tuple is now parsed,
    // but the existing grounding still rejects its unsupported content.
    const broken = '{"i":[["broken","broken",0021000,0051000]}}]'
    expect(inspectCompactWriterPayload(parseWriterJsonRecord(broken)!).expandedItemCount).toBe(1)
    expect(parse(broken).information).toHaveLength(0)
  })

  it('preserves Mac numeric line references and resolves repaired IDs through the same map', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const references = encodeMacNotesLineReferences(
      '[00:21] The rollout is paused until the crash rate drops.'
    )
    const raw =
      '{"information":[{"t":"Release","h":"Rollout paused","c":"The rollout is paused until the crash rate drops.","s":1,"e":1}]}'
    const provider = new OllamaProvider('http://localhost:11435', 'test-model')
    const parseMac = (payload: string) =>
      (provider as any).parseResponseWithStats(
        'meeting-mac',
        payload,
        undefined,
        60000,
        [21000],
        transcript.slice(0, 1),
        references.startMsByLineId
      ).segments
    expect(repairJsonLeadingZeroIntegers(raw).json).toBe(raw)
    expect(parseMac(raw.replaceAll(':1', ':001'))).toEqual(parseMac(raw))
    expect(parseMac(raw).information[0]).toMatchObject({ sourceStartMs: 21000, sourceEndMs: 21000 })
  })

  it('accepts a padded streaming chat response on the first attempt', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const fetchMock = vi.fn(async () => {
      const chunks = [padded.slice(0, 17), padded.slice(17, 73), padded.slice(73)]
      return new Response(
        chunks
          .map((content, i) =>
            JSON.stringify({
              message: { content },
              done: i === chunks.length - 1
            })
          )
          .join('\n') + '\n'
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OllamaProvider('http://localhost:11435', 'test-model')
    const result = await provider.summarize(
      'meeting-stream',
      '[00:21] The rollout is paused until the crash rate drops.\n[00:51] Trial starts improved twelve percent.',
      undefined,
      1
    )
    expect(result.information).toHaveLength(1)
    expect(provider.getLastWriterSkips()).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(url).toBe('http://localhost:11435/api/chat')
    expect(JSON.parse(String(init.body))).toMatchObject({
      format: 'json',
      stream: true,
      options: { temperature: 0 }
    })
  })
})
