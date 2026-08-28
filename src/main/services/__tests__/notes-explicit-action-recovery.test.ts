import { describe, expect, it } from 'vitest'
import type { MeetingSegments, Segment, Transcript } from '../../../shared/types'
import { recoverExplicitTranscriptActions } from '../notes-explicit-action-recovery'

const meetingId = 'meeting-explicit-action-recovery'

function emptySegments(): MeetingSegments {
  return {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
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
    startMs: 1_000,
    endMs: 2_000,
    confidence: 1,
    ...overrides
  }
}

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: 'writer-segment-1',
    meetingId,
    category: 'action_item',
    topic: null,
    title: 'Ping Sergio after the meeting',
    content: 'Ping Sergio after the meeting to get the testing estimate.',
    assignee: 'Me',
    deadline: null,
    sourceStartMs: 1_000,
    sourceEndMs: 2_000,
    ...overrides
  }
}

describe('recoverExplicitTranscriptActions', () => {
  it('rejects deictic commitments without a supported deliverable', () => {
    const result = recoverExplicitTranscriptActions(
      emptySegments(),
      [
        transcript('them', "We'll do it through the vendor."),
        transcript('me', "I'll do that tomorrow.", { startMs: 2_000, endMs: 3_000 })
      ],
      { localOwnerLabel: 'Me' }
    )

    expect(result.recoveredActionCount).toBe(0)
    expect(result.segments.actionItems).toEqual([])
  })

  it('recovers the truncated canary commitment without rewriting its purpose', () => {
    const result = recoverExplicitTranscriptActions(
      emptySegments(),
      [
        transcript(
          'me',
          "Yeah, I'll ping Sergio after the meeting just to find out when they'll be done testing.",
          { startMs: 1_515_000, endMs: 1_521_000 }
        )
      ],
      { localOwnerLabel: 'Me' }
    )

    expect(result).toMatchObject({
      recoveredActionCount: 1,
      promotedActionCount: 0,
      dedupedRecoveredActionCount: 0
    })
    expect(result.segments.actionItems).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^recovered-action:[a-f0-9]{16}$/),
        meetingId,
        category: 'action_item',
        topic: null,
        title: 'Ping Sergio after the meeting',
        content: "Ping Sergio after the meeting just to find out when they'll be done testing.",
        assignee: 'Me',
        deadline: null,
        sourceStartMs: 1_515_000,
        sourceEndMs: 1_521_000
      })
    ])
  })

  it.each([
    ['me', "Maybe I'll ping Sergio after the meeting."],
    ['me', "I think I'll ping Sergio after the meeting."],
    ['me', "I'll probably ping Sergio after the meeting."],
    ['me', "I won't ping Sergio after the meeting."],
    ['me', "I'll ping Sergio if we have time."],
    ['me', 'Let me know when Sergio finishes testing.'],
    ['me', "I'll do that."],
    ['me', "I'll check."],
    ['me', "I'll remind him that."],
    ['me', "I'll send it."],
    ['me', "I'll handle this."],
    ['me', "Sergio said, ‘I'll approve the payment.’"],
    ['me', 'Sergio said Norbert will add the app version field.'],
    ['me', 'According to Sergio, Norbert will add the app version field.'],
    ['me', 'I pinged Sergio after the meeting.'],
    ['them', 'Android will release the new build today.']
  ])('rejects non-explicit or unsafe recovery: [%s] %s', (speaker, text) => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [transcript(speaker, text)])

    expect(result.segments.actionItems).toEqual([])
    expect(result.recoveredActionCount).toBe(0)
    expect(result.promotedActionCount).toBe(0)
  })

  it.each([
    ['them', "I'll send the release estimate after the build arrives."],
    ['them', 'We will publish the reliability dashboard tomorrow.'],
    ['me', 'Can you review the deployment checklist?'],
    ['them', 'Please archive the incident report.']
  ])(
    'recovers an explicit remote commitment or request without inventing an owner: [%s] %s',
    (speaker, text) => {
      const result = recoverExplicitTranscriptActions(emptySegments(), [transcript(speaker, text)])

      expect(result.segments.actionItems).toHaveLength(1)
      expect(result.segments.actionItems[0]?.assignee).toBeNull()
      expect(result.recoveredActionCount).toBe(1)
    }
  )

  it('recovers separate commitments from a long punctuation-poor transcript row', () => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript(
        'me',
        "I'm planning to refine the notes layout every day and then I'll send the reviewers an internal build and then I'll publish the launch brief."
      )
    ])

    expect(result.segments.actionItems.map((item) => item.title)).toEqual([
      'Publish the launch brief',
      'Refine the notes layout every day',
      'Send the reviewers an internal build'
    ])
    expect(result.segments.actionItems.map((item) => item.assignee)).toEqual(['Me', 'Me', 'Me'])
  })

  it.each([
    ['me', "I'll just turn."],
    ['me', "I'll remember and this may be the deployment branch that."],
    ['me', "I'll double check and make sure that's working."],
    ['me', "I'll talk to you tomorrow at stand up."],
    ['me', "I'll uh, I'll talk to you tomorrow and stand up."],
    ['them', "I'll talk with them about it, but it should send half as often."],
    ['them', 'Can you hear me?'],
    ['them', 'Please see the shared screen.']
  ])('rejects incomplete, deictic, setup, or social action noise: [%s] %s', (speaker, text) => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [transcript(speaker, text)])

    expect(result.segments.actionItems).toEqual([])
    expect(result.recoveredActionCount).toBe(0)
  })

  it.each([
    ['them', 'Can you repeat please?'],
    ['them', 'The dialog says please connect from your device when there is an error.'],
    ['them', "We'll determine what we want to do then."],
    ['them', "We'll follow the answer."],
    ['them', "We'll look into the ones because it was a while ago."],
    ['them', "We're going to switch to lifetime."],
    ['them', "We'll let you use it during the trial."],
    ['me', "I'll keep you updated."],
    ['them', "I'll tag you there okay all right then we can move on."],
    ['them', "I'll take a look at that and then discuss memory requirements."],
    ['them', "I'll adjust the nice."],
    ['them', "I'll say okay for you."],
    ['them', 'Could you tell it to use another language?'],
    ['them', "We'll drive with um on screen input."],
    ['them', "I'll look into to refine it a bit."],
    ['them', "I'll take a look at the updated version of more detail."],
    ['them', 'I will share the debug endpoints that Okay.']
  ])('rejects low-information or run-on ASR actions: [%s] %s', (speaker, text) => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [transcript(speaker, text)])

    expect(result.segments.actionItems).toEqual([])
    expect(result.recoveredActionCount).toBe(0)
  })

  it.each([
    ['them', "I'll send the invite."],
    ['them', "I'm going to redo analytics opt-in tracking."],
    ['them', "We'll share the updated link in the channel."],
    ['me', "I'll get the pipeline working on Mac."],
    ['them', "I'll set the flags to return the same type."]
  ])('keeps concrete commitments after ASR quality filtering: [%s] %s', (speaker, text) => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [transcript(speaker, text)])

    expect(result.segments.actionItems).toHaveLength(1)
    expect(result.recoveredActionCount).toBe(1)
  })

  it('removes internal ASR filler words from an otherwise concrete action', () => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('them', "I'm going to redo the uh the um analytics uh opt-in tracking.")
    ])

    expect(result.segments.actionItems[0]?.content).toBe('Redo the analytics opt-in tracking.')
  })

  it.each([
    ['Jordan, please send the signed APK to the beta users.', 'Jordan'],
    ['Avery Chen, can you review the Android crash logs?', 'Avery Chen']
  ])('recovers an explicitly named assignment or request: %s', (text, owner) => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [transcript('them', text)])

    expect(result.segments.actionItems).toHaveLength(1)
    expect(result.segments.actionItems[0]).toMatchObject({ assignee: owner })
  })

  it('recovers a single-token named assignment after independent person context', () => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('them', 'I asked Norbert about the cancellation report.', {
        id: 'person-context',
        startMs: 500,
        endMs: 900
      }),
      transcript('them', 'Norbert will add the app version to the cancellation report.', {
        id: 'assignment',
        startMs: 1_000,
        endMs: 2_000
      })
    ])

    expect(result.segments.actionItems).toEqual([
      expect.objectContaining({
        assignee: 'Norbert',
        title: expect.stringContaining('Add the app version')
      })
    ])
  })

  it.each(['Notion', 'Linear', 'Finance'])(
    'does not assign an ambiguous organization-shaped subject as person owner: %s',
    (owner) => {
      const result = recoverExplicitTranscriptActions(emptySegments(), [
        transcript('them', `${owner} will document the rollout process.`)
      ])

      expect(result.segments.actionItems).toEqual([])
      expect(result.recoveredActionCount).toBe(0)
    }
  )

  it('rejects a multi-token owner identified elsewhere as a workspace', () => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('them', 'We track the launch in Acme Workspace.', {
        id: 'workspace-context',
        startMs: 500,
        endMs: 900
      }),
      transcript('them', 'Acme Workspace will notify the beta users.', {
        id: 'organization-assignment',
        startMs: 1_000,
        endMs: 2_000
      })
    ])

    expect(result.segments.actionItems).toEqual([])
  })

  it.each([
    ['email', 'the launch brief'],
    ['schedule', 'the QA review'],
    ['deploy', 'the signed build'],
    ['monitor', 'the error rate'],
    ['write', 'the release notes'],
    ['remove', 'the stale flag'],
    ['call', 'the vendor'],
    ['notify', 'the beta users'],
    ['document', 'the rollout process']
  ])('recovers the common explicit action verb %s', (verb, object) => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('me', `I'll ${verb} ${object}.`)
    ])

    expect(result.segments.actionItems).toEqual([
      expect.objectContaining({ title: expect.stringMatching(new RegExp(`^${verb}`, 'i')) })
    ])
  })

  it('recovers a clear unknown verb with an object but not a pronominal fragment', () => {
    const grounded = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('me', "I'll archive the incident report.")
    ])
    const fragment = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('me', "I'll archive it.")
    ])

    expect(grounded.segments.actionItems).toEqual([
      expect.objectContaining({ title: 'Archive the incident report' })
    ])
    expect(fragment.segments.actionItems).toEqual([])
  })

  it('does not duplicate a writer action already supported by the same commitment', () => {
    const segments = emptySegments()
    segments.actionItems.push(segment())

    const result = recoverExplicitTranscriptActions(segments, [
      transcript('me', "I'll ping Sergio after the meeting to get the testing estimate.")
    ])

    expect(result.segments.actionItems).toEqual(segments.actionItems)
    expect(result.recoveredActionCount).toBe(0)
    expect(result.dedupedRecoveredActionCount).toBe(1)
  })

  it('enriches a duplicate writer action with a cited named-assignment owner', () => {
    const segments = emptySegments()
    const writerAction = segment({
      title: 'Email the launch brief',
      content: 'Email the launch brief to beta users.',
      assignee: null
    })
    segments.actionItems.push(writerAction)

    const result = recoverExplicitTranscriptActions(segments, [
      transcript('them', 'Avery Chen will email the launch brief to beta users.')
    ])

    expect(result.segments.actionItems).toEqual([{ ...writerAction, assignee: 'Avery Chen' }])
    expect(result.recoveredActionCount).toBe(0)
    expect(result.dedupedRecoveredActionCount).toBe(1)
  })

  it('does not enrich a duplicate writer action when its citation excludes the assignment', () => {
    const segments = emptySegments()
    const writerAction = segment({
      title: 'Email the launch brief',
      content: 'Email the launch brief to beta users.',
      assignee: null,
      sourceStartMs: 5_000,
      sourceEndMs: 6_000
    })
    segments.actionItems.push(writerAction)

    const result = recoverExplicitTranscriptActions(segments, [
      transcript('them', 'Avery Chen will email the launch brief to beta users.')
    ])

    expect(result.segments.actionItems).toEqual([writerAction])
    expect(result.dedupedRecoveredActionCount).toBe(1)
  })

  it('promotes an action-shaped information record while preserving its writer fields', () => {
    const segments = emptySegments()
    const writerInformation = segment({
      category: 'information',
      topic: 'QA',
      deadline: 'After the meeting'
    })
    segments.information.push(writerInformation)

    const result = recoverExplicitTranscriptActions(segments, [
      transcript('me', "I'll ping Sergio after the meeting to get the testing estimate.")
    ])

    expect(result.segments.information).toEqual([])
    expect(result.segments.actionItems).toEqual([
      {
        ...writerInformation,
        category: 'action_item',
        assignee: 'Me'
      }
    ])
    expect(result.promotedActionCount).toBe(1)
    expect(result.recoveredActionCount).toBe(0)
  })

  it('does not promote neutral information that merely mentions the same people and topic', () => {
    const segments = emptySegments()
    const neutralInformation = segment({
      category: 'information',
      title: 'Sergio owns QA testing',
      content: 'Sergio is currently testing the build.',
      assignee: null
    })
    segments.information.push(neutralInformation)

    const result = recoverExplicitTranscriptActions(segments, [
      transcript('me', "I'll ping Sergio after the meeting to get the testing estimate.")
    ])

    expect(result.segments.information).toEqual([neutralInformation])
    expect(result.segments.actionItems).toHaveLength(1)
    expect(result.promotedActionCount).toBe(0)
    expect(result.recoveredActionCount).toBe(1)
  })

  it('does not promote a current in-progress status as a future action', () => {
    const segments = emptySegments()
    const currentStatus = segment({
      category: 'status_update',
      title: 'QA log review in progress',
      content: "I'm checking the QA logs now.",
      assignee: null
    })
    segments.statusUpdates.push(currentStatus)

    const result = recoverExplicitTranscriptActions(segments, [
      transcript('me', "I'll check the QA logs after the meeting.")
    ])

    expect(result.segments.statusUpdates).toEqual([currentStatus])
    expect(result.segments.actionItems).toHaveLength(1)
    expect(result.promotedActionCount).toBe(0)
    expect(result.recoveredActionCount).toBe(1)
  })

  it('does not suppress a different action merely because its verb and topic overlap', () => {
    const segments = emptySegments()
    segments.actionItems.push(
      segment({
        title: 'Ping Gabor about QA testing',
        content: 'Ping Gabor about QA testing.',
        assignee: null
      })
    )

    const result = recoverExplicitTranscriptActions(segments, [
      transcript('me', "I'll ping Sergio about QA testing.")
    ])

    expect(result.segments.actionItems.map((item) => item.title)).toEqual([
      'Ping Gabor about QA testing',
      'Ping Sergio about QA testing'
    ])
    expect(result.recoveredActionCount).toBe(1)
    expect(result.dedupedRecoveredActionCount).toBe(0)
  })

  it('deduplicates repeated commitments but keeps different objects separate', () => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('me', "I'll ping Sergio about QA testing.", {
        id: 'row-1',
        startMs: 1_000,
        endMs: 2_000
      }),
      transcript('me', "I'll ping Sergio about QA testing.", {
        id: 'row-2',
        startMs: 3_000,
        endMs: 4_000
      }),
      transcript('me', "I'll ping Gabor about the cancellation report.", {
        id: 'row-3',
        startMs: 5_000,
        endMs: 6_000
      })
    ])

    expect(result.segments.actionItems.map((item) => item.title)).toEqual([
      'Ping Sergio about QA testing',
      'Ping Gabor about the cancellation report'
    ])
    expect(result.recoveredActionCount).toBe(2)
    expect(result.dedupedRecoveredActionCount).toBe(1)
  })

  it('rejects a garbled fragment and keeps the self-contained commitment', () => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript(
        'me',
        "No, I I need to ask Sergio again'cause I asked him whenever we we provide U estimateŰ00Űolly ready As soon as he",
        {
          id: 'row-garbled',
          startMs: 349_000,
          endMs: 355_000
        }
      ),
      transcript(
        'me',
        "Yeah, I'll ping Sergio after the meeting just to find out when they'll be done testing.",
        {
          id: 'row-clean',
          startMs: 1_515_000,
          endMs: 1_521_000
        }
      )
    ])

    expect(result.segments.actionItems).toEqual([
      expect.objectContaining({
        title: 'Ping Sergio after the meeting',
        content: "Ping Sergio after the meeting just to find out when they'll be done testing.",
        sourceStartMs: 1_515_000,
        sourceEndMs: 1_521_000
      })
    ])
    expect(result.recoveredActionCount).toBe(1)
    expect(result.dedupedRecoveredActionCount).toBe(0)
  })

  it('retains both named scopes for an immediate conditional approval continuation', () => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('them', 'Just wait for them reaching out to us to give them approval.', {
        id: 'row-condition',
        startMs: 10_000,
        endMs: 14_000
      }),
      transcript('me', 'Yeah, just make sure you do it for both Duet Display and SuperDisplay.', {
        id: 'row-scope',
        startMs: 14_100,
        endMs: 17_000
      })
    ])

    expect(result.segments.actionItems).toEqual([
      expect.objectContaining({
        title: 'Give approval for both Duet Display and SuperDisplay',
        content: 'Give approval for both Duet Display and SuperDisplay after they reach out.',
        assignee: null,
        deadline: null,
        sourceStartMs: 10_000,
        sourceEndMs: 17_000
      })
    ])
    expect(result.recoveredActionCount).toBe(1)
  })

  it('does not resolve a scoped pronoun request without adjacent conditional action evidence', () => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('them', 'The approval process is still being reviewed.', {
        id: 'row-context',
        startMs: 10_000,
        endMs: 14_000
      }),
      transcript('me', 'Make sure you do it for both Duet Display and SuperDisplay.', {
        id: 'row-scope',
        startMs: 14_100,
        endMs: 17_000
      })
    ])

    expect(result.segments.actionItems).toEqual([])
  })

  it('does not recover a reported scoped continuation', () => {
    const result = recoverExplicitTranscriptActions(emptySegments(), [
      transcript('them', 'Wait for them reaching out to us to give them approval.', {
        id: 'row-condition',
        startMs: 10_000,
        endMs: 14_000
      }),
      transcript(
        'me',
        'Sergio said, “Make sure you do it for both Duet Display and SuperDisplay.”',
        { id: 'row-reported-scope', startMs: 14_100, endMs: 17_000 }
      )
    ])

    expect(result.segments.actionItems).toEqual([])
  })

  it('does not mutate the input segment collections', () => {
    const segments = emptySegments()
    const originalInformation = segment({ category: 'information' })
    segments.information.push(originalInformation)

    recoverExplicitTranscriptActions(segments, [
      transcript('me', "I'll ping Sergio after the meeting to get the testing estimate.")
    ])

    expect(segments.information).toEqual([originalInformation])
    expect(segments.actionItems).toEqual([])
  })
})
