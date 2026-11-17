import { describe, expect, it, vi } from 'vitest'
import {
  calculateEvidenceOperation,
  calculateValidatedEvidence,
  evidenceNumericLiterals,
  numericLiteral
} from '../ask-ai-calculations'
import {
  executeWriterTool,
  parseWriterToolText,
  validateWriterToolCall,
  type WriterToolContext
} from '../ask-ai-writer-tools'
import type { MeetingInventoryEntry } from '../chat-retrieval'
const calculate = (
  operation: string,
  values: Array<string | number>,
  evidence = values.join(' and ')
) => calculateValidatedEvidence(operation, values, evidence)

describe('evidence-bound exact decimal arithmetic', () => {
  it('separates an amount and a percentage instead of consuming a comma-separated list as one number', () => {
    expect(evidenceNumericLiterals('$120,000, 15%')).toEqual(['$120,000', '15%'])
    expect(numericLiteral('€1.234,50')).toEqual({ units: 123450n, scale: 2, currency: 'EUR' })
    expect(numericLiteral('$0.10')).toEqual({ units: 10n, scale: 2, currency: 'USD' })
  })
  it('retains the ported CL binary operations', () => {
    expect(calculateEvidenceOperation('$0.30', '$0.10', '-').result).toBe(0.2)
    expect(calculateEvidenceOperation('$120', '$100', 'percent_change').result).toBe(20)
  })
  it.each([
    ['sum', ['0.1', '0.2'], '0.3', ''],
    ['difference', ['$120,000', '$50,000'], '70000', 'USD'],
    ['ratio', ['2', '0.5'], '4', ''],
    ['percentage', ['$10', '$40'], '25', '%'],
    ['mean', ['1', '2', '6'], '3', ''],
    ['percentage_change', ['$120', '$100'], '20', '%'],
    ['percentage_amount', ['$120,000', '15%'], '18000', 'USD']
  ])('calculates %s with decimal-safe native arithmetic', (operation, values, result, unit) => {
    expect(calculate(operation as string, values as string[])).toMatchObject({
      result,
      unit,
      rounded: false
    })
  })
  it('binds unformatted model numbers to the units of evidence and rejects fabricated operands', () => {
    expect(
      calculate('difference', [120000, 50000], 'Approved $120,000; proposal $50,000.')
    ).toMatchObject({ result: '70000', unit: 'USD' })
    expect(() => calculate('sum', [120000, 999], 'The budget is $120,000, 15% reserve.')).toThrow(
      /absent/
    )
    expect(() => calculate('sum', ['USD10', 'EUR20'])).toThrow(/Incompatible/)
    expect(() => calculate('ratio', [1, 0])).toThrow(/zero/)
    expect(() => calculate('sum', [9007199254740992, 1])).toThrow(/precision/)
  })
  it('marks repeating division as rounded rather than pretending its decimal is exact', () => {
    expect(calculate('ratio', [1, 3])).toMatchObject({
      result: '0.333333333333',
      rounded: true,
      decimalPlaces: 12
    })
  })
})
function recording(
  id: string,
  date: number,
  title: string,
  participants: string[]
): MeetingInventoryEntry {
  return {
    id,
    date,
    title,
    participants,
    dir: '/unused',
    calendarTitle: null,
    sourceName: null,
    sourceApp: null,
    slackChannel: null,
    attendees: [],
    notePreview: null,
    transcriptStatus: 'notes',
    metadataSearchText: '',
    aliases: [],
    normalizedAliases: []
  }
}
const tool = (filter: Record<string, unknown>) => ({
  function: { name: 'count_recordings', arguments: { filter } }
})
describe('native count filters over inventory and the existing lexical index', () => {
  it('intersects date, title, participant and full-content keyword matches and states the exact filter', async () => {
    const inventory = [
      recording('old', new Date(2026, 7, 31).getTime(), 'Budget review', ['Mara']),
      recording('late', new Date(2026, 8, 30, 23, 50).getTime(), 'Budget review', ['Mara Innes']),
      recording('next', new Date(2026, 9, 1).getTime(), 'Budget review', ['Mara']),
      recording('other', new Date(2026, 8, 15).getTime(), 'Budget review', ['Ivo'])
    ]
    const query = vi.fn(async () =>
      inventory.map((m) => ({ meetingId: m.id, title: m.title, date: m.date, matches: [] }))
    )
    const result = await executeWriterTool(
      tool({
        from: '2026-09-01',
        through: '2026-09-30',
        title: 'budget',
        participant: 'Mara',
        keyword: 'reserve ceiling',
        list: true
      }),
      { evidence: '', inventory: async () => inventory, query }
    )
    expect(query).toHaveBeenCalledWith('reserve ceiling')
    expect(result).toMatchObject({
      count: 1,
      recordings: [{ meetingId: 'late', date: '2026-09-30' }],
      listed: 1,
      truncated: false
    })
    expect(result.filterDescription).toContain(
      'notes or transcript contain all keyword terms "reserve ceiling"'
    )
    expect(result.filterDescription).toContain('on or after 2026-09-01')
  })
  it('preserves scope and keeps a full exact count when only a bounded list is returned', async () => {
    const inventory = Array.from({ length: 15 }, (_, i) => recording(String(i), i, 'Review', []))
    const context: WriterToolContext = {
      evidence: '',
      inventory: async () => inventory,
      query: vi.fn()
    }
    expect(await executeWriterTool(tool({ list: true }), context)).toMatchObject({
      count: 15,
      listed: 10,
      truncated: true
    })
    expect(
      await executeWriterTool(tool({}), { ...context, scopedMeetingIds: ['2'] })
    ).toMatchObject({ count: 1, filterDescription: 'attached saved recordings (no filters)' })
  })
  it('returns validation errors to the model, never guesses or repairs bad arguments', async () => {
    const context = { evidence: 'Budget $120,000, 15%.', inventory: vi.fn(), query: vi.fn() }
    expect(await executeWriterTool(tool({ from: '2026-02-30' }), context)).toMatchObject({
      error: expect.stringMatching(/date/)
    })
    expect(
      await executeWriterTool(
        { function: { name: 'calculate', arguments: { operation: 'sum', values: [120000, 999] } } },
        context
      )
    ).toMatchObject({ error: expect.stringMatching(/absent/) })
    expect(context.inventory).not.toHaveBeenCalled()
  })
})

describe('tool calls written as text', () => {
  it.each([
    ['{"name":"count_recordings","parameters":{"filter":"{\\"a\\"'],
    ['  { "name" : "calculate", "param'],
    ['<tool_call>{"name":"calculate"}</tool_call>'],
    ['{"name":"count_recordings","parameters":{"filter":{"list":true}}} and then some prose']
  ])('recognises an unusable call to a declared tool: %s', (text) => {
    expect(parseWriterToolText(text)).toMatchObject({ kind: 'named' })
  })
  it.each([
    ['{"budget":18600}'],
    ['{"name":"Mira"}'],
    ['{"name":"count_rec'],
    ['[1,2]'],
    ['Mira.']
  ])('leaves other text alone: %s', (text) => {
    expect(parseWriterToolText(text)).toBeNull()
  })
  it('parses a complete call, with either parameters or arguments, and tag wrappers', () => {
    const filter = { list: true }
    for (const text of [
      JSON.stringify({ name: 'count_recordings', parameters: { filter } }),
      `<tool_call>${JSON.stringify({ name: 'count_recordings', arguments: { filter } })}</tool_call>`
    ])
      expect(parseWriterToolText(text)).toEqual({
        kind: 'call',
        call: { function: { name: 'count_recordings', arguments: { filter } } }
      })
  })
  it('shares one validation with execution', async () => {
    const bad = { function: { name: 'count_recordings', arguments: { filter: { list: 'false' } } } }
    expect(() => validateWriterToolCall(bad, '')).toThrow('Invalid list option')
    expect(() =>
      validateWriterToolCall(
        { function: { name: 'count_recordings', arguments: { filter: '{}' } } },
        ''
      )
    ).toThrow('Supply a recording filter object')
    expect(
      validateWriterToolCall(
        { function: { name: 'count_recordings', arguments: { filter: { list: true } } } },
        ''
      )
    ).toMatchObject({ tool: 'count_recordings' })
    const context = { evidence: '', inventory: vi.fn(), query: vi.fn() } as WriterToolContext
    expect(await executeWriterTool(bad, context)).toEqual({ error: 'Invalid list option' })
  })
})
