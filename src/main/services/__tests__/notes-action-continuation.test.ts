import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeetingNotesContent, Transcript } from '../../../shared/types'
import { restoreActionContinuations } from '../notes-action-continuation'

function row(text: string, startMs: number, endMs: number, speaker = 'me'): Transcript {
  return { id: String(startMs), meetingId: 'meeting', text, startMs, endMs, speaker, confidence: 1 }
}
function notes(text = 'Get more information about the setup.'): MeetingNotesContent {
  return {
    overview: null,
    keyTakeaways: [],
    sections: [],
    decisions: [],
    nextSteps: [
      {
        id: 'recovered-action:setup',
        title: text,
        text,
        owner: 'Jamie',
        deadline: 'tomorrow',
        topic: null,
        completed: true,
        provenance: 'generated',
        sources: [{ startMs: 1000, endMs: 3000 }]
      }
    ]
  }
}
afterEach(() => vi.restoreAllMocks())

describe('restoring explanations from a recovered commitment’s utterance', () => {
  it('identifies the reported issue while retaining the speaker’s uncertainty and the original task', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes()
    const rows = [
      row('I need to get more information about the setup.', 1000, 3000),
      row('Because the ticket says the local mouse stops working when Duet runs.', 3200, 6500),
      row('But I am not sure I understand the report.', 6600, 8000)
    ]
    const result = restoreActionContinuations(input, rows)
    expect(result.count).toBe(1)
    expect(result.content.nextSteps).toEqual([
      {
        ...input.nextSteps[0],
        title: null,
        text: 'Get more information about the setup. Because the ticket says the local mouse stops working when Duet runs. But I am not sure I understand the report.',
        sources: [{ startMs: 1000, endMs: 8000 }]
      }
    ])
    for (const key of ['overview', 'keyTakeaways', 'sections', 'decisions'] as const) {
      expect(result.content[key]).toBe(input[key])
    }
    expect(input.nextSteps[0].text).toBe('Get more information about the setup.')
    expect(restoreActionContinuations(result.content, rows).content).toBe(result.content)
  })

  it('preserves a prerequisite from the same transcript row', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes('Eventually finish the feature.')
    const text =
      "We'll eventually finish the feature. It's just that we need the shared foundation first."
    const result = restoreActionContinuations(input, [row(text, 1000, 3000)])
    expect(result.content.nextSteps[0].text).toBe(
      "Eventually finish the feature. It's just that we need the shared foundation first."
    )
  })

  it('restores an explicit prerequisite even when ASR puts it after the commitment', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes('Ship build 443.')
    const result = restoreActionContinuations(input, [
      row('I will ship build 443.', 1000, 3000),
      row('Only if QA approves the release.', 3100, 5000)
    ])
    expect(result.content.nextSteps[0].text).toBe(
      'Ship build 443. Only if QA approves the release.'
    )
    expect(result.content.nextSteps[0].completed).toBe(input.nextSteps[0].completed)
  })

  it('reconstructs a split explanation and ignores a short backchannel', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const result = restoreActionContinuations(notes(), [
      row('I need to get more information about the setup.', 1000, 3000),
      row('Yeah.', 3100, 3500, 'them'),
      row('Because the local mouse', 3300, 5000),
      row('stops working when Duet runs.', 5000, 7000)
    ])
    expect(result.content.nextSteps[0].text).toBe(
      'Get more information about the setup. Because the local mouse stops working when Duet runs.'
    )
  })

  it.each([
    ['nearby different topic', [row('The other issue is a keyboard crash.', 3100, 6000)]],
    ['different speaker', [row('Because our keyboard stopped working.', 3100, 6000, 'them')]],
    ['later explanation', [row('Because the mouse stopped working.', 5000, 7000)]],
    ['separate commitment', [row('Because I will send the keyboard logs tomorrow.', 3100, 6000)]],
    [
      'explanation with a separate task',
      [
        row(
          'Because the mouse stopped working. I will send the keyboard logs tomorrow.',
          3100,
          6000
        )
      ]
    ],
    [
      'unrelated intervening statement',
      [
        row('The keyboard problem is different.', 3100, 4000),
        row('Because it happens only on Windows.', 4100, 6000)
      ]
    ]
  ])('does not borrow %s', (_label, continuation) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes()
    const result = restoreActionContinuations(input, [
      row('I need to get more information about the setup.', 1000, 3000),
      ...continuation
    ])
    expect(result.content).toBe(input)
    expect(result.count).toBe(0)
  })

  it('does not expand two tasks at the same anchor or overlap another task', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    for (const startMs of [1000, 3200]) {
      const input = notes()
      input.nextSteps.push({
        ...input.nextSteps[0],
        id: 'other-task',
        sources: [{ startMs, endMs: 6000 }]
      })
      expect(
        restoreActionContinuations(input, [
          row('I need to get more information about the setup.', 1000, 3000),
          row('Because the mouse stopped working.', 3100, 6500)
        ]).content
      ).toBe(input)
    }
  })

  it('does not attach the explanation of a different topic introduced in the commitment row', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes()
    expect(
      restoreActionContinuations(input, [
        row(
          'I need to get more information about the setup. The billing issue is different.',
          1000,
          3000
        ),
        row('Because the receipts were lost.', 3100, 6000)
      ]).content
    ).toBe(input)
  })

  it('does not copy a topic change bundled into the explanatory row', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes()
    const result = restoreActionContinuations(input, [
      row('I need to get more information about the setup.', 1000, 3000),
      row('Because the mouse stops working. The separate billing issue is urgent.', 3100, 6000),
      row('Because the receipts were lost.', 6100, 8000)
    ])
    expect(result.content).toBe(input)
  })

  it('does not silently trim an unrecognized caveat off an added explanation', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes()
    const result = restoreActionContinuations(input, [
      row('I need to get more information about the setup.', 1000, 3000),
      row('Because the mouse stops working. I could be wrong about that.', 3100, 6000)
    ])
    expect(result.content).toBe(input)
  })

  it('also preserves uncertainty when ASR places the caveat in a separate row', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes()
    expect(
      restoreActionContinuations(input, [
        row('I need to get more information about the setup.', 1000, 3000),
        row('Because the mouse stops working.', 3100, 6000),
        row('I could be wrong about that.', 6100, 8000)
      ]).content
    ).toBe(input)
  })

  it('does not use a partial explanation when its caveat falls across the time limit', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes()
    expect(
      restoreActionContinuations(input, [
        row('I need to get more information about the setup.', 1000, 3000),
        row('Because the mouse stops working.', 3100, 30_500),
        row('But that may be a misunderstanding.', 31_100, 34_000)
      ]).content
    ).toBe(input)
  })

  it('stops at an explicit new topic without copying it into the task', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes()
    const result = restoreActionContinuations(input, [
      row('I need to get more information about the setup.', 1000, 3000),
      row('Because the mouse stops working.', 3100, 6000),
      row('Moving on to the budget.', 6100, 8000)
    ])
    expect(result.content.nextSteps[0].text).toBe(
      'Get more information about the setup. Because the mouse stops working.'
    )
  })

  it('keeps the completed explanation when the next task spans several ASR rows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const result = restoreActionContinuations(notes(), [
      row('I need to get more information about the setup.', 1000, 3000),
      row('Because the mouse stops working.', 3100, 6000),
      row('I will create a separate issue for', 6100, 25_000),
      row('the keyboard problem.', 25_000, 40_000)
    ])
    expect(result.content.nextSteps[0].text).toBe(
      'Get more information about the setup. Because the mouse stops working.'
    )
  })

  it('does not copy half an explanation when duplex ASR interleaves another channel', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const input = notes()
    expect(
      restoreActionContinuations(input, [
        row('I need to get more information about the setup.', 1000, 3000),
        row('Because it was being sent as a mouse event,', 3000, 6000),
        row(
          'Because it was being sent as a mouse event, but also as a touch event.',
          3500,
          7500,
          'them'
        ),
        row('but also as a touch event.', 6000, 7600)
      ]).content
    ).toBe(input)
  })

  it.each(['win32', 'linux'] as const)('leaves %s output unchanged', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const input = notes()
    expect(
      restoreActionContinuations(input, [
        row(
          'I need to get more information about the setup. Because the mouse stopped working.',
          1000,
          3000
        )
      ]).content
    ).toBe(input)
  })

  it('leaves contextual writer actions and user edits unchanged', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    for (const changes of [
      { title: 'Investigate the reported mouse failure' },
      { provenance: 'user' as const },
      { id: 'writer-action' }
    ]) {
      const input = notes()
      Object.assign(input.nextSteps[0], changes)
      expect(
        restoreActionContinuations(input, [
          row(
            'I need to get more information about the setup. Because the mouse stopped working.',
            1000,
            3000
          )
        ]).content
      ).toBe(input)
    }
  })
})
