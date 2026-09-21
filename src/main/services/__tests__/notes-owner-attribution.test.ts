import { describe, expect, it } from 'vitest'
import type { Segment, Transcript } from '../../../shared/types'
import { resolveSpeakerAwareOwner } from '../notes-owner-attribution'

const meetingId = 'meeting-owner-attribution'

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: 'segment-1',
    meetingId,
    category: 'action_item',
    topic: 'Release',
    title: 'Send the release estimate',
    content: 'Send the release estimate after the build arrives.',
    assignee: null,
    deadline: null,
    sourceStartMs: 1_000,
    sourceEndMs: 2_000,
    ...overrides
  }
}

function transcript(
  speaker: string,
  text: string,
  overrides: Partial<Transcript> = {}
): Transcript {
  return {
    id: 'row-1',
    meetingId,
    speaker,
    text,
    startMs: 1_100,
    endMs: 1_900,
    confidence: 1,
    ...overrides
  }
}

describe('resolveSpeakerAwareOwner', () => {
  it('preserves an explicit named owner only when the name appears in cited evidence', () => {
    const writerSegment = segment({ assignee: 'Avery Chen' })

    expect(
      resolveSpeakerAwareOwner(writerSegment, [
        transcript('them', 'Avery Chen will send the estimate once the build arrives.')
      ])
    ).toBe('Avery Chen')

    expect(
      resolveSpeakerAwareOwner(writerSegment, [
        transcript('them', 'The estimate will be sent once the build arrives.')
      ])
    ).toBeNull()
  })

  it('matches named owners case-insensitively without accepting longer-name substrings', () => {
    expect(
      resolveSpeakerAwareOwner(segment({ assignee: 'AVERY CHEN' }), [
        transcript('them', 'Avery Chen owns the release estimate.')
      ])
    ).toBe('AVERY CHEN')

    expect(
      resolveSpeakerAwareOwner(segment({ assignee: 'Ann' }), [
        transcript('them', 'Anna owns the release estimate.')
      ])
    ).toBeNull()
  })

  it('does not use matching names outside the cited range or from another meeting', () => {
    const writerSegment = segment({ assignee: 'Jordan' })
    const outsideRange = transcript('them', 'Jordan owns the estimate.', {
      id: 'row-outside',
      startMs: 4_000,
      endMs: 5_000
    })
    const otherMeeting = transcript('them', 'Jordan owns the estimate.', {
      id: 'row-other-meeting',
      meetingId: 'another-meeting'
    })

    expect(resolveSpeakerAwareOwner(writerSegment, [outsideRange, otherMeeting])).toBeNull()
  })

  it.each([
    "I'll send the estimate.",
    'I will send the estimate.',
    "I'm going to send the release estimate.",
    'Let me send the release estimate.'
  ])('maps an explicit [me] commitment to the confirmed local owner: %s', (text) => {
    expect(resolveSpeakerAwareOwner(segment(), [transcript('me', text)], 'Chris')).toBe('Chris')
  })

  it('replaces a generic writer owner with the confirmed local owner for an explicit [me] commitment', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ assignee: 'me' }),
        [transcript('ME', 'I’ll send the estimate.')],
        '  Chris  '
      )
    ).toBe('Chris')
  })

  it('does not assign the local owner without a confirmed label or an explicit commitment', () => {
    expect(
      resolveSpeakerAwareOwner(segment(), [transcript('me', "I'll send the estimate.")])
    ).toBeNull()
    expect(
      resolveSpeakerAwareOwner(
        segment(),
        [transcript('me', 'I think the estimate should go out soon.')],
        'Chris'
      )
    ).toBeNull()
  })

  it('never infers an individual from a [them] first-person commitment', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ assignee: 'them' }),
        [transcript('them', "I'll send the estimate.")],
        'Chris'
      )
    ).toBeNull()
  })

  it('does not assign a collective [me] commitment to the local individual', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ title: 'Add iOS analytics', content: 'Add iOS discovery analytics.' }),
        [transcript('me', 'We need to add iOS discovery analytics.')],
        'Chris'
      )
    ).toBeNull()
  })

  it('does not assign a quoted commitment to the current local speaker', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ title: 'Approve payment', content: 'Approve the payment.' }),
        [transcript('me', "Sergio said, ‘I'll approve the payment.’")],
        'Chris'
      )
    ).toBeNull()
  })

  it('does not preserve an owner from a reported named assignment', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ assignee: 'Norbert', title: 'Add app version', content: 'Add app version.' }),
        [transcript('them', 'Sergio said Norbert will add the app version.')]
      )
    ).toBeNull()
  })

  it('does not treat a request for information as a local commitment', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment(),
        [transcript('me', 'Let me know when the release estimate is ready.')],
        'Chris'
      )
    ).toBeNull()
  })

  it('does not turn a negated local statement into a commitment', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment(),
        [transcript('me', 'I will not send the release estimate.')],
        'Chris'
      )
    ).toBeNull()
    expect(
      resolveSpeakerAwareOwner(
        segment(),
        [transcript('me', 'I will definitely not send the release estimate.')],
        'Chris'
      )
    ).toBeNull()
  })

  it('attributes a terse pronominal commitment when the action verb is exact', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ title: 'Approve payment', content: 'Approve the payment.' }),
        [transcript('me', "I'll approve it.")],
        'Chris'
      )
    ).toBe('Chris')
  })

  it('does not use an unrelated local commitment elsewhere in a broad cited range', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ sourceStartMs: 1_000, sourceEndMs: 5_000 }),
        [transcript('me', "I'll review the Android crash logs tomorrow.")],
        'Chris'
      )
    ).toBeNull()
  })

  it('does not preserve a merely mentioned name without assignment context', () => {
    expect(
      resolveSpeakerAwareOwner(segment({ assignee: 'Jordan' }), [
        transcript('them', 'Jordan raised a concern about when the release estimate will arrive.')
      ])
    ).toBeNull()
  })

  it.each([
    'Jordan should send the release estimate.',
    'Jordan can send the release estimate.',
    'Jordan will not send the release estimate.',
    'Jordan will definitely not send the release estimate.'
  ])('does not turn named modality or negation into ownership: %s', (text) => {
    expect(
      resolveSpeakerAwareOwner(segment({ assignee: 'Jordan' }), [transcript('them', text)])
    ).toBeNull()
  })

  it.each([
    'Jordan, please send the release estimate.',
    'Jordan, can you send the release estimate?'
  ])('preserves a named owner for a direct request: %s', (text) => {
    expect(
      resolveSpeakerAwareOwner(segment({ assignee: 'Jordan' }), [transcript('them', text)])
    ).toBe('Jordan')
  })

  it('does not preserve a named assignment for an unrelated action in a broad range', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ assignee: 'Jordan', sourceStartMs: 1_000, sourceEndMs: 5_000 }),
        [transcript('them', 'Jordan will review the Android crash logs tomorrow.')]
      )
    ).toBeNull()
  })

  it('rejects team labels as named owners', () => {
    expect(
      resolveSpeakerAwareOwner(segment({ assignee: 'Support Team' }), [
        transcript('them', 'Support Team will send the release estimate.')
      ])
    ).toBeNull()
  })

  it.each(['Notion', 'Linear', 'Finance'])(
    'does not preserve an ambiguous organization-shaped writer owner: %s',
    (owner) => {
      expect(
        resolveSpeakerAwareOwner(
          segment({
            assignee: owner,
            title: 'Document the rollout process',
            content: 'Document the rollout process.'
          }),
          [transcript('them', `${owner} will document the rollout process.`)]
        )
      ).toBeNull()
    }
  )

  it('still accepts a named remote owner with explicit assignment and person context', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ assignee: 'Jordan' }),
        [
          transcript('them', 'I asked Jordan for the estimate.', {
            id: 'row-person-context',
            startMs: 100,
            endMs: 500
          }),
          transcript('them', 'Jordan will send the estimate.')
        ],
        'Chris'
      )
    ).toBe('Jordan')
  })

  it('does not use distant person context to validate an ambiguous single-token owner', () => {
    expect(
      resolveSpeakerAwareOwner(segment({ assignee: 'Jordan' }), [
        transcript('them', 'I asked Jordan for the estimate.', {
          id: 'row-distant-person-context',
          startMs: 90_000,
          endMs: 91_000
        }),
        transcript('them', 'Jordan will send the estimate.')
      ])
    ).toBeNull()
  })

  it('fails closed for invalid source ranges', () => {
    expect(
      resolveSpeakerAwareOwner(
        segment({ sourceStartMs: 2_000, sourceEndMs: 1_000, assignee: 'Jordan' }),
        [transcript('them', 'Jordan will send the estimate.')],
        'Chris'
      )
    ).toBeNull()
  })
})
