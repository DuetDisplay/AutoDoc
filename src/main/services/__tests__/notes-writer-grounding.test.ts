import { describe, expect, it } from 'vitest'
import {
  sanitizeWriterRecord,
  sanitizeWriterRecords,
  type WriterGroundingLine
} from '../notes-writer-grounding'

describe('sanitizeWriterRecord', () => {
  it('does not mistake the first word of a sentence for an unsupported proper name', () => {
    expect(
      sanitizeWriterRecord(
        'information',
        {
          title: 'Opted-in tester count',
          content: 'There are 16 people who have opted in so far.'
        },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: 'We have a total of 16 people that have opted in so far.' }]
      )
    ).toMatchObject({
      category: 'information',
      content: 'There are 16 people who have opted in so far.'
    })

    expect(
      sanitizeWriterRecord(
        'information',
        { title: 'Tester count', content: 'There are 16 Nimbus testers.' },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: 'There are 16 testers.' }]
      )
    ).toBeNull()
  })

  it('keeps a strongly related, safely grounded paraphrase', () => {
    expect(
      sanitizeWriterRecord(
        'information',
        {
          title: 'Navigation remains confusing',
          content: 'Consumers find the generated notes difficult to navigate.'
        },
        { startMs: 10_000, endMs: 10_000 },
        [
          {
            startMs: 10_000,
            text: 'The consumer finds it confusing trying to flip through the generated notes.'
          }
        ]
      )
    ).toMatchObject({ category: 'information' })
  })

  it('localizes polarity and modality within long punctuation-poor ASR rows', () => {
    expect(
      sanitizeWriterRecord(
        'information',
        { title: 'Navigation issue', content: 'Customers find the report confusing to navigate.' },
        { startMs: 10_000, endMs: 10_000 },
        [
          {
            startMs: 10_000,
            text: "customers find the report confusing to navigate okay yeah no that's fair and the next item might need more research"
          }
        ]
      )
    ).toMatchObject({ category: 'information' })

    expect(
      sanitizeWriterRecord(
        'information',
        {
          title: 'Release sequence',
          content: 'After version 3.5 is released, we will run the campaign.'
        },
        { startMs: 20_000, endMs: 20_000 },
        [
          {
            startMs: 20_000,
            text: "once we release 3.5 then we'll run the campaign and maybe that will improve retention"
          }
        ]
      )
    ).toMatchObject({ category: 'information' })
  })

  it('drops vague passive fragments produced by conservative clause salvage', () => {
    expect(
      sanitizeWriterRecord(
        'information',
        {
          title: 'Review process',
          content: 'Feedback will be gathered after the pilot is complete.'
        },
        { startMs: 30_000, endMs: 30_000 },
        [{ startMs: 30_000, text: 'Feedback will be gathered, but the timing is uncertain.' }]
      )
    ).toBeNull()
  })

  it('does not use a cited clause fallback without strong subject overlap', () => {
    expect(
      sanitizeWriterRecord(
        'information',
        { title: 'Deployment result', content: 'The deployment completed successfully.' },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: 'The monthly billing limit remains active.' }]
      )
    ).toBeNull()
  })

  it('keeps a cited long-row commitment verbatim when the action paraphrase is too loose', () => {
    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Prepare reviewer build', content: 'Prepare an internal build for review.' },
        { startMs: 10_000, endMs: 10_000 },
        [
          {
            startMs: 10_000,
            text: "I'll get the reviewers an internal build to use in their meetings."
          }
        ]
      )
    ).toMatchObject({
      category: 'action_items',
      content: "I'll get the reviewers an internal build to use in their meetings",
      salvaged: true
    })
  })

  it('rejects an action item whose grounded text ends as an incomplete request', () => {
    expect(
      sanitizeWriterRecord(
        'action_items',
        {
          title: 'Reproduction request',
          content: 'Ask the test group to find a setup that reproduces the issue, can you'
        },
        { startMs: 10_000, endMs: 10_000 },
        [
          {
            startMs: 10_000,
            text: 'Can we ask the test group to find a setup that reproduces the issue, can you'
          }
        ]
      )
    ).toBeNull()
  })

  it('salvages the grounded clause and drops a bundled unsupported trial comparison', () => {
    const lines: WriterGroundingLine[] = [
      {
        startMs: 49_000,
        text: 'Windows is just barely ahead. On Mac, four four three is behind, but just barely; the numbers are coming together.'
      },
      {
        startMs: 64_000,
        text: 'Trial starts on four four are better than 435 on both.'
      }
    ]

    const result = sanitizeWriterRecord(
      'information',
      {
        title: 'Mac trial start rate behind Windows but converging',
        content:
          'On Mac, version 443 is behind but closing the gap; on Windows, trial starts are stronger and converging.'
      },
      { startMs: 49_000, endMs: 64_000 },
      lines
    )

    expect(result).toMatchObject({
      category: 'information',
      content: 'On Mac, version 443 is behind but closing the gap',
      title: 'On Mac, version 443 is behind but closing the gap',
      sourceStartMs: 49_000,
      sourceEndMs: 49_000,
      salvaged: true
    })
    expect(result?.content).not.toContain('trial starts')
    expect(result?.content).not.toContain('435')

    expect(
      sanitizeWriterRecords(
        'information',
        {
          title: 'Mac trial start rate behind Windows but converging',
          content:
            'On Mac, version 443 is behind but closing the gap; on Windows, trial starts are stronger and converging.'
        },
        { startMs: 49_000, endMs: 64_000 },
        lines
      ).map((record) => record.content)
    ).toEqual(['On Mac, version 443 is behind but closing the gap'])
  })

  it('rejects a percentage bound to the wrong metric', () => {
    const lines: WriterGroundingLine[] = [
      {
        startMs: 114_000,
        text: 'Windows converged more today, but yesterday was five percent more.'
      },
      { startMs: 123_000, text: 'I think that had an effect on the cancellation rate.' }
    ]

    expect(
      sanitizeWriterRecord(
        'information',
        {
          title: 'New version shows 5% higher cancellation rate',
          content: 'The new version has a 5% higher cancellation rate.'
        },
        { startMs: 114_000, endMs: 123_000 },
        lines
      )
    ).toBeNull()
  })

  it('rejects a lifetime-to-25% association absent from the quantitative line', () => {
    const lines: WriterGroundingLine[] = [
      { startMs: 249_000, text: 'It is at a sacrifice of lifetime.' },
      { startMs: 255_000, text: 'You can see here it is like a twenty-five percent increase.' }
    ]

    expect(
      sanitizeWriterRecord(
        'information',
        {
          title: 'Lifetime trial conversion shows 25% increase',
          content: 'Lifetime trial conversion increased by 25% compared with baseline.'
        },
        { startMs: 249_000, endMs: 255_000 },
        lines
      )
    ).toBeNull()
  })

  it('reclassifies a factual result presented under decisions', () => {
    const result = sanitizeWriterRecord(
      'decisions',
      {
        title: 'Build 443 is ahead on Windows',
        content: 'Build 443 is barely ahead on Windows.'
      },
      { startMs: 10_000, endMs: 10_000 },
      [{ startMs: 10_000, text: 'On Windows, build 443 is barely ahead.' }]
    )

    expect(result?.category).toBe('information')
  })

  it('rejects a false Stripe action but keeps an explicit first-person commitment', () => {
    expect(
      sanitizeWriterRecord(
        'action_items',
        {
          title: 'Review Stripe performance',
          content: 'Review Stripe week-over-week performance.'
        },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: "I don't know if you checked out Stripe." }]
      )
    ).toBeNull()

    expect(
      sanitizeWriterRecord(
        'action_items',
        {
          title: 'Ask Sergio for the QA estimate',
          content: 'Ask Sergio for the QA estimate.',
          deadline: 'Today'
        },
        { startMs: 20_000, endMs: 20_000 },
        [{ startMs: 20_000, text: "I'll ask Sergio for the QA estimate." }]
      )
    ).toMatchObject({
      category: 'action_items',
      deadline: null
    })

    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Handle the follow-up', content: 'Handle the follow-up.' },
        { startMs: 30_000, endMs: 30_000 },
        [{ startMs: 30_000, text: "I'll handle the follow-up." }]
      )
    ).toMatchObject({ category: 'action_items' })

    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Handle the follow-up', content: 'Handle the follow-up.' },
        { startMs: 40_000, endMs: 40_000 },
        [{ startMs: 40_000, text: 'I will definitely not handle the follow-up.' }]
      )
    ).toBeNull()
  })

  it('tolerates one nearby transcript line when the writer citation ends early', () => {
    const result = sanitizeWriterRecord(
      'action_items',
      {
        title: 'Add local discovery analytics to iOS',
        content: 'Add local discovery analytics to iOS.'
      },
      { startMs: 10_000, endMs: 10_000 },
      [
        { startMs: 10_000, text: 'For the iOS side,' },
        { startMs: 18_000, text: 'we need to add local discovery analytics to iOS.' }
      ]
    )

    expect(result).toMatchObject({
      category: 'action_items',
      content: 'Add local discovery analytics to iOS.',
      sourceStartMs: 18_000,
      sourceEndMs: 18_000
    })
  })

  it('uses at most two nearby lines to salvage a rollout gate without its unsupported platform tail', () => {
    const results = sanitizeWriterRecords(
      'information',
      {
        title: 'Free tier release timing',
        content:
          'Free tier release pending completion of smoke tests; planned for 50/50 split after iOS and Android testing completes'
      },
      { startMs: 18_000, endMs: 24_000 },
      [
        { startMs: 10_000, text: 'Are we planning to release the free tier?' },
        { startMs: 13_000, text: 'I think it is through testing.' },
        {
          startMs: 18_000,
          text: 'Whenever smoke tests finish, we were going to release it at fifty fifty.'
        },
        { startMs: 22_000, text: 'On iOS, it has not gone to QA yet.' },
        { startMs: 24_000, text: 'Okay.' }
      ]
    )

    expect(results.map((record) => record.content)).toEqual([
      'Free tier release pending completion of smoke tests',
      'planned for 50/50 split'
    ])
    expect(results.every((record) => record.sourceEndMs - record.sourceStartMs <= 30_000)).toBe(
      true
    )
  })

  it('grounds an explicit beta-program plan even when Planned begins the summary', () => {
    expect(
      sanitizeWriterRecord(
        'action_items',
        {
          title: 'Plan Android rewrite beta test',
          content: 'Planned beta test program for the Android rewrite version.'
        },
        { startMs: 10_000, endMs: 10_000 },
        [
          {
            startMs: 10_000,
            text: "I'm planning to put together a beta test program for the Android rewrite version."
          }
        ]
      )
    ).toMatchObject({ category: 'action_items' })
  })

  it('salvages an Android release commitment before an unsupported QA rationale', () => {
    expect(
      sanitizeWriterRecord(
        'action_items',
        {
          title: 'Start Android RC release',
          content: 'Begin Android RC release today after QA approval.'
        },
        { startMs: 10_000, endMs: 18_000 },
        [
          {
            startMs: 10_000,
            text: 'The Android RC finished testing, so I will start the release today.'
          },
          { startMs: 18_000, text: 'It passed QA.' }
        ]
      )
    ).toMatchObject({
      category: 'action_items',
      content: 'Begin Android RC release today',
      salvaged: true
    })
  })

  it('rejects visibly mixed-script transcription garbage', () => {
    expect(
      sanitizeWriterRecord(
        'information',
        {
          title: 'Connection report',
          content: 'One user reports no connections in Cent UΌ.'
        },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: 'One user reports no connections in Cent UΌ.' }]
      )
    ).toBeNull()
  })

  it('supplements a grounded first clause with a nearby cited-tail detail', () => {
    expect(
      sanitizeWriterRecords(
        'information',
        {
          title: 'Android rewrite beta plan',
          content:
            'Collecting users with USB connectivity issues; plan to distribute the signed APK to those users'
        },
        { startMs: 10_000, endMs: 10_000 },
        [
          { startMs: 10_000, text: 'I started collecting users with USB connectivity issues.' },
          { startMs: 18_000, text: 'My plan is to share the signed APK with those users.' }
        ]
      ).map((record) => record.content)
    ).toEqual([
      'Collecting users with USB connectivity issues; plan to distribute the signed APK to those users'
    ])
  })

  it('rejects a tentative action instead of promoting it to a commitment', () => {
    const results = sanitizeWriterRecords(
      'action_items',
      {
        title: 'Add local connection changes to iOS',
        content:
          'Need to get the local connection changes added to iOS to enable accurate analytics.'
      },
      { startMs: 10_000, endMs: 10_000 },
      [
        {
          startMs: 10_000,
          text: 'Maybe we need to get those local connection changes put into iOS as well.'
        }
      ]
    )

    expect(results).toEqual([])
  })

  it('keeps the grounded trial/revenue tradeoff as discussion', () => {
    const result = sanitizeWriterRecord(
      'discussion',
      {
        title: 'More trials can raise revenue despite lower conversion',
        content: 'More trials can raise revenue even if fewer users convert.'
      },
      { startMs: 150_000, endMs: 150_000 },
      [
        {
          startMs: 150_000,
          text: "We'll get more revenue if we get more trials, even if fewer of them convert."
        }
      ]
    )

    expect(result).toMatchObject({ category: 'discussion', salvaged: false })
  })

  it('rejects swapped platform quantities and directions', () => {
    const quantityLines: WriterGroundingLine[] = [
      { startMs: 10_000, text: 'Mac trial starts increased 12 percent.' },
      { startMs: 18_000, text: 'Windows trial starts increased 5 percent.' }
    ]

    expect(
      sanitizeWriterRecords(
        'information',
        {
          title: 'Trial starts by platform',
          content: 'Mac trial starts increased 5%; Windows trial starts increased 12%.'
        },
        { startMs: 10_000, endMs: 18_000 },
        quantityLines
      )
    ).toEqual([])

    expect(
      sanitizeWriterRecord(
        'information',
        { title: 'Mac is behind', content: 'Mac is behind.' },
        { startMs: 30_000, endMs: 38_000 },
        [
          { startMs: 30_000, text: 'Mac is ahead.' },
          { startMs: 38_000, text: 'Windows is behind.' }
        ]
      )
    ).toBeNull()
  })

  it('keeps an exact rollout percentage without a hard-coded metric name', () => {
    expect(
      sanitizeWriterRecord(
        'information',
        {
          title: 'Desktop free tier rollout',
          content: 'Roll out the desktop free tier to 50% of users.'
        },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: 'Roll out the desktop free tier to fifty percent of users.' }]
      )
    ).toMatchObject({ category: 'information' })
  })

  it('binds actions to an affirmative speech act with the same predicate', () => {
    const draft = { title: 'Add iOS analytics', content: 'Add iOS analytics.' }

    expect(
      sanitizeWriterRecord('action_items', draft, { startMs: 10_000, endMs: 10_000 }, [
        { startMs: 10_000, text: 'I will definitely not add iOS analytics.' }
      ])
    ).toBeNull()
    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Check Stripe', content: 'Check Stripe.' },
        { startMs: 20_000, endMs: 20_000 },
        [{ startMs: 20_000, text: 'Did you check Stripe?' }]
      )
    ).toBeNull()
    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Send QA estimate', content: 'Send the QA estimate.' },
        { startMs: 30_000, endMs: 30_000 },
        [{ startMs: 30_000, text: "I'll review the QA estimate." }]
      )
    ).toBeNull()
    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Investigate the failure', content: 'Investigate the failure.' },
        { startMs: 40_000, endMs: 40_000 },
        [{ startMs: 40_000, text: 'Let me investigate the failure.' }]
      )
    ).toMatchObject({ category: 'action_items' })
  })

  it('does not attach an unsupported person or causal rationale', () => {
    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Ping Sergio', content: 'Ping Sergio.' },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: "I'll ping him." }]
      )
    ).toBeNull()

    const causal = sanitizeWriterRecords(
      'information',
      { title: 'Release timing', content: 'Release today because QA passed.' },
      { startMs: 20_000, endMs: 28_000 },
      [
        { startMs: 20_000, text: 'The release is today.' },
        { startMs: 28_000, text: 'QA passed earlier.' }
      ]
    )
    expect(causal.map((record) => record.content)).toEqual(['Release today'])
  })

  it('strips unsupported tokenless deadlines and does not borrow a distant action cue', () => {
    expect(
      sanitizeWriterRecord(
        'action_items',
        {
          title: 'Approve payment',
          content: 'Approve the payment.',
          deadline: 'EOD'
        },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: "I'll approve the payment." }]
      )
    ).toMatchObject({ deadline: null })

    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Review QA estimate', content: 'Review the QA estimate.' },
        { startMs: 20_000, endMs: 40_000 },
        [
          { startMs: 20_000, text: 'The QA estimate needs review.' },
          { startMs: 25_000, text: 'The release build is ready.' },
          { startMs: 30_000, text: 'The smoke test passed.' },
          { startMs: 35_000, text: 'The rollout remains paused.' },
          { startMs: 40_000, text: "I'll review a different support report." }
        ]
      )
    ).toBeNull()
  })

  it('rejects factual summaries contradicted by negation or tentative evidence', () => {
    expect(
      sanitizeWriterRecord(
        'information',
        { title: 'Encryption enabled', content: 'Encryption is enabled.' },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: 'Encryption is not enabled.' }]
      )
    ).toBeNull()

    expect(
      sanitizeWriterRecord(
        'information',
        { title: 'Release timing', content: 'The release ships Friday.' },
        { startMs: 20_000, endMs: 20_000 },
        [{ startMs: 20_000, text: 'Maybe the release ships Friday.' }]
      )
    ).toBeNull()

    expect(
      sanitizeWriterRecord(
        'discussion',
        { title: 'Release risk', content: 'The release may slip.' },
        { startMs: 30_000, endMs: 30_000 },
        [{ startMs: 30_000, text: 'Maybe the release may slip.' }]
      )
    ).toMatchObject({ category: 'discussion' })
  })

  it('binds platform quantities and directions within the same transcript clause', () => {
    const evidence: WriterGroundingLine[] = [
      {
        startMs: 10_000,
        text: 'Mac trial starts increased 12%; Windows trial starts decreased 5%.'
      }
    ]

    expect(
      sanitizeWriterRecords(
        'information',
        {
          title: 'Trial starts by platform',
          content: 'Mac trial starts decreased 5%; Windows trial starts increased 12%.'
        },
        { startMs: 10_000, endMs: 10_000 },
        evidence
      )
    ).toEqual([])

    expect(
      sanitizeWriterRecords(
        'information',
        {
          title: 'Trial and cancellation direction',
          content: 'Trial starts increased; cancellation rate decreased.'
        },
        { startMs: 20_000, endMs: 20_000 },
        [
          {
            startMs: 20_000,
            text: 'Trial starts decreased; cancellation rate increased.'
          }
        ]
      )
    ).toEqual([])
  })

  it('requires causal subjects and objects in the same causal clause', () => {
    expect(
      sanitizeWriterRecord(
        'information',
        { title: 'Pricing caused churn', content: 'Pricing caused churn.' },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: 'Pricing caused complaints; churn remained stable.' }]
      )
    ).toBeNull()

    expect(
      sanitizeWriterRecord(
        'information',
        { title: 'Pricing caused churn', content: 'Pricing caused churn.' },
        { startMs: 20_000, endMs: 20_000 },
        [{ startMs: 20_000, text: 'Pricing caused churn.' }]
      )
    ).toMatchObject({ category: 'information' })
  })

  it('requires the concrete decision object to occur in the decision speech act', () => {
    expect(
      sanitizeWriterRecord(
        'decisions',
        {
          title: 'Monthly pricing decision',
          content: 'The team decided pricing stays monthly.'
        },
        { startMs: 10_000, endMs: 10_000 },
        [
          {
            startMs: 10_000,
            text: 'We decided pricing should be annual, but monthly billing was discussed.'
          }
        ]
      )
    ).toBeNull()

    expect(
      sanitizeWriterRecord(
        'decisions',
        {
          title: 'Annual pricing decision',
          content: 'The team decided pricing stays annual.'
        },
        { startMs: 20_000, endMs: 20_000 },
        [{ startMs: 20_000, text: 'We decided pricing should be annual.' }]
      )
    ).toMatchObject({ category: 'decisions' })
  })

  it('grounds a concrete proposal explicitly accepted on the following line', () => {
    expect(
      sanitizeWriterRecord(
        'decisions',
        {
          title: 'Delay broad launch',
          content: 'We will delay the broad launch and finish the reliability work first.'
        },
        { startMs: 10_000, endMs: 12_000 },
        [
          {
            startMs: 10_000,
            text: 'Do you think the right approach is to delay the broad launch and finish the reliability work first?'
          },
          { startMs: 12_000, text: 'Sounds good.' }
        ]
      )
    ).toMatchObject({ category: 'decisions' })

    expect(
      sanitizeWriterRecord(
        'decisions',
        { title: 'Delay broad launch', content: 'We will delay the broad launch.' },
        { startMs: 20_000, endMs: 22_000 },
        [
          { startMs: 20_000, text: 'The broad launch was discussed.' },
          { startMs: 22_000, text: 'Sounds good.' }
        ]
      )
    ).toBeNull()
  })

  it('requires an evidence anchor for every explicit or alternative', () => {
    const draft = {
      title: 'Play Console approval path',
      content: 'Approval will be granted via button in Play Console or email.'
    }

    expect(
      sanitizeWriterRecord('information', draft, { startMs: 10_000, endMs: 50_000 }, [
        {
          startMs: 10_000,
          text: 'The approval will come later through Play Console.'
        },
        {
          startMs: 18_000,
          text: 'Approval management is shown in Play Console.'
        },
        {
          startMs: 50_000,
          text: "For approval, I think maybe there will be a button in Play Console or another email, but I don't know."
        }
      ])
    ).toBeNull()

    expect(
      sanitizeWriterRecord('information', draft, { startMs: 60_000, endMs: 60_000 }, [
        {
          startMs: 60_000,
          text: 'Approval will be granted via a button in Play Console or an email.'
        }
      ])
    ).toMatchObject({ category: 'information' })
  })

  it('does not treat a future completion as completed without non-future evidence', () => {
    const draft = {
      title: 'Android RC testing completed',
      content: 'Android RC testing completed.'
    }

    expect(
      sanitizeWriterRecord('status_updates', draft, { startMs: 10_000, endMs: 10_000 }, [
        {
          startMs: 10_000,
          text: 'Android RC will finish testing, so I will start the release today.'
        }
      ])
    ).toBeNull()

    expect(
      sanitizeWriterRecord('status_updates', draft, { startMs: 10_000, endMs: 18_000 }, [
        {
          startMs: 10_000,
          text: 'Android RC will finish testing, so I will start the release today.'
        },
        { startMs: 18_000, text: 'It passed QA.' }
      ])
    ).toMatchObject({
      category: 'status_updates',
      sourceStartMs: 10_000,
      sourceEndMs: 18_000
    })

    const compoundDraft = {
      title: 'Android RC release status',
      content: 'Android RC testing completed; release scheduled to start today.'
    }
    const futureOnly = sanitizeWriterRecords(
      'status_updates',
      compoundDraft,
      { startMs: 10_000, endMs: 10_000 },
      [
        {
          startMs: 10_000,
          text: 'Android RC will finish testing, so I will start the release today.'
        }
      ]
    )
    expect(futureOnly.every((record) => !/completed/i.test(record.content))).toBe(true)

    expect(
      sanitizeWriterRecord('status_updates', compoundDraft, { startMs: 10_000, endMs: 18_000 }, [
        {
          startMs: 10_000,
          text: 'Android RC will finish testing, so I will start the release today.'
        },
        { startMs: 18_000, text: 'It passed QA.' }
      ])
    ).toMatchObject({
      content: compoundDraft.content,
      sourceStartMs: 10_000,
      sourceEndMs: 18_000,
      salvaged: false
    })
  })

  it('binds quantity-first coordinated values to their own platform or build', () => {
    const platformDraft = {
      title: 'Trial starts by platform',
      content: 'Trial starts increased 8% on Mac and 14% on Windows.'
    }

    expect(
      sanitizeWriterRecord('information', platformDraft, { startMs: 10_000, endMs: 10_000 }, [
        {
          startMs: 10_000,
          text: 'Trial starts increased 14% on Mac and 8% on Windows.'
        }
      ])
    ).toBeNull()
    expect(
      sanitizeWriterRecord('information', platformDraft, { startMs: 20_000, endMs: 20_000 }, [
        { startMs: 20_000, text: platformDraft.content }
      ])
    ).toMatchObject({ category: 'information' })

    const buildDraft = {
      title: 'Build allocation',
      content: 'Build 701 is on Mac and build 702 is on Windows.'
    }
    expect(
      sanitizeWriterRecord('information', buildDraft, { startMs: 30_000, endMs: 30_000 }, [
        { startMs: 30_000, text: 'Build 702 is on Mac and build 701 is on Windows.' }
      ])
    ).toBeNull()
    expect(
      sanitizeWriterRecord('information', buildDraft, { startMs: 40_000, endMs: 40_000 }, [
        { startMs: 40_000, text: buildDraft.content }
      ])
    ).toMatchObject({ category: 'information' })
  })

  it('does not bind one platform completion to another platform subject', () => {
    const draft = {
      title: 'Windows client testing completed',
      content: 'Windows client testing completed.'
    }

    expect(
      sanitizeWriterRecord('status_updates', draft, { startMs: 10_000, endMs: 18_000 }, [
        { startMs: 10_000, text: 'Windows client testing will finish tomorrow.' },
        { startMs: 18_000, text: 'Mac client passed QA.' }
      ])
    ).toBeNull()
    expect(
      sanitizeWriterRecord('status_updates', draft, { startMs: 30_000, endMs: 30_000 }, [
        { startMs: 30_000, text: 'Windows client passed QA.' }
      ])
    ).toMatchObject({ category: 'status_updates' })
  })

  it('does not bind completion across desktop or product entity boundaries', () => {
    expect(
      sanitizeWriterRecord(
        'status_updates',
        {
          title: 'Android RC testing completed',
          content: 'Android RC testing completed.'
        },
        { startMs: 10_000, endMs: 18_000 },
        [
          { startMs: 10_000, text: 'Android RC testing will finish tomorrow.' },
          { startMs: 18_000, text: 'Desktop smoke testing completed today.' }
        ]
      )
    ).toBeNull()

    expect(
      sanitizeWriterRecord(
        'status_updates',
        {
          title: 'Android Orchid rewrite testing completed',
          content: 'Android Orchid rewrite testing completed.'
        },
        { startMs: 20_000, endMs: 28_000 },
        [
          { startMs: 20_000, text: 'Android Orchid rewrite testing will finish tomorrow.' },
          { startMs: 28_000, text: 'Android Juniper rewrite testing completed today.' }
        ]
      )
    ).toBeNull()

    expect(
      sanitizeWriterRecord(
        'status_updates',
        {
          title: 'Orchid client testing completed',
          content: 'Orchid client testing completed.'
        },
        { startMs: 30_000, endMs: 38_000 },
        [
          { startMs: 30_000, text: 'Orchid client testing will finish tomorrow.' },
          { startMs: 38_000, text: 'Juniper client testing completed today.' }
        ]
      )
    ).toBeNull()

    expect(
      sanitizeWriterRecord(
        'status_updates',
        {
          title: 'Orchid client testing completed',
          content: 'Orchid client testing completed.'
        },
        { startMs: 50_000, endMs: 50_000 },
        [{ startMs: 50_000, text: 'Orchid client testing completed today.' }]
      )
    ).toMatchObject({ category: 'status_updates' })

    expect(
      sanitizeWriterRecord(
        'status_updates',
        {
          title: 'Desktop smoke testing completed',
          content: 'Desktop smoke testing completed.'
        },
        { startMs: 60_000, endMs: 60_000 },
        [{ startMs: 60_000, text: 'Desktop smoke testing completed today.' }]
      )
    ).toMatchObject({ category: 'status_updates' })
  })

  it('binds each or branch to its own state and relationship', () => {
    const draft = {
      title: 'Access path after review',
      content: 'Access will be available by code or link after review.'
    }

    expect(
      sanitizeWriterRecord('information', draft, { startMs: 10_000, endMs: 18_000 }, [
        { startMs: 10_000, text: 'Code access will be available after review.' },
        { startMs: 18_000, text: 'Link access is unavailable after review.' }
      ])
    ).toBeNull()
    const relationshipMismatch = sanitizeWriterRecord(
      'information',
      draft,
      { startMs: 30_000, endMs: 38_000 },
      [
        { startMs: 30_000, text: 'Code access will be available after review.' },
        { startMs: 38_000, text: 'Link access will be available before review.' }
      ]
    )
    expect(relationshipMismatch).toMatchObject({
      content: 'Access will be available by code or link',
      salvaged: true
    })
    expect(relationshipMismatch?.content).not.toContain('after review')
    expect(
      sanitizeWriterRecord('information', draft, { startMs: 50_000, endMs: 58_000 }, [
        { startMs: 50_000, text: 'Code access will be available after review.' },
        { startMs: 58_000, text: 'Link access will be available after review.' }
      ])
    ).toMatchObject({ category: 'information' })
  })

  it('requires the action body predicate without borrowing support from its title', () => {
    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Review deployment report', content: 'Send the deployment report.' },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: "I'll review the deployment report." }]
      )
    ).toBeNull()
    expect(
      sanitizeWriterRecord(
        'action_items',
        { title: 'Deployment follow-up', content: 'Review the deployment report.' },
        { startMs: 20_000, endMs: 20_000 },
        [{ startMs: 20_000, text: "I'll review the deployment report." }]
      )
    ).toMatchObject({ category: 'action_items' })
  })

  it('requires a percentage to share its real metric or subject context', () => {
    const draft = {
      title: 'Adoption coverage',
      content: 'The adoption metric covers 37% of users.'
    }

    expect(
      sanitizeWriterRecord('information', draft, { startMs: 10_000, endMs: 10_000 }, [
        {
          startMs: 10_000,
          text: 'The rollout metric covers thirty-seven percent of users.'
        }
      ])
    ).toBeNull()
    expect(
      sanitizeWriterRecord('information', draft, { startMs: 20_000, endMs: 20_000 }, [
        {
          startMs: 20_000,
          text: 'The adoption metric covers thirty-seven percent of users.'
        }
      ])
    ).toMatchObject({ category: 'information' })
  })

  it('salvages a grounded coordinated plan before an unsupported without tail', () => {
    const draft = {
      title: 'Beta distribution plan',
      content:
        'Plan to collect participant addresses and distribute signed beta package for testing without marketplace submission.'
    }
    const evidence: WriterGroundingLine[] = [
      { startMs: 10_000, text: 'I plan to collect participant addresses from the beta group.' },
      {
        startMs: 18_000,
        text: 'My plan is to share the signed beta package for testing.'
      }
    ]

    expect(
      sanitizeWriterRecord('action_items', draft, { startMs: 10_000, endMs: 18_000 }, evidence)
    ).toMatchObject({
      category: 'action_items',
      content:
        'Plan to collect participant addresses and distribute signed beta package for testing',
      salvaged: true
    })

    const partiallyGrounded = sanitizeWriterRecord(
      'action_items',
      draft,
      { startMs: 30_000, endMs: 30_000 },
      [{ startMs: 30_000, text: 'I plan to collect participant addresses from the beta group.' }]
    )
    expect(partiallyGrounded).toMatchObject({
      content: 'Plan to collect participant addresses',
      salvaged: true
    })
    expect(partiallyGrounded?.content).not.toMatch(/distribute|without/i)

    const inheritedPlanBranch = sanitizeWriterRecord(
      'action_items',
      {
        title: 'Rewrite beta plan',
        content:
          'Plan to collect email addresses from users with USB connectivity issues and distribute rewrite APK for testing without store submission.'
      },
      { startMs: 10_000, endMs: 24_000 },
      [
        {
          startMs: 10_000,
          text: 'I started collecting email addresses for users with USB connectivity issues.'
        },
        { startMs: 12_000, text: 'Nine emails so far.' },
        { startMs: 14_000, text: 'I will also ask for more affected users.' },
        { startMs: 16_000, text: 'Once I have something ready to share.' },
        {
          startMs: 18_000,
          text: 'That is built from the rewrite code base. My plan is to ask these users to try that version.'
        },
        { startMs: 20_000, text: 'It is easier to test this version directly.' },
        { startMs: 22_000, text: 'I can create a signed APK.' },
        { startMs: 24_000, text: 'And share that with these users.' }
      ]
    )
    expect(inheritedPlanBranch).toMatchObject({
      category: 'action_items',
      content: 'distribute rewrite APK for testing',
      sourceStartMs: 18_000,
      sourceEndMs: 22_000,
      salvaged: true
    })
  })

  it('uses release lifecycle equivalence only with grounded context', () => {
    const draft = {
      title: 'Rollout target',
      content: 'target 50/50 rollout after QA completion.'
    }

    expect(
      sanitizeWriterRecord('information', draft, { startMs: 10_000, endMs: 10_000 }, [
        {
          startMs: 10_000,
          text: 'Whenever smoke tests are done, we are going to release it at fifty fifty.'
        }
      ])
    ).toMatchObject({
      content: 'target 50/50 rollout',
      salvaged: true
    })

    expect(
      sanitizeWriterRecord('information', draft, { startMs: 20_000, endMs: 20_000 }, [
        {
          startMs: 20_000,
          text: 'Whenever smoke tests are done, we are going to release it at sixty forty.'
        }
      ])
    ).toBeNull()

    expect(
      sanitizeWriterRecord(
        'information',
        { title: 'Shipping plan', content: 'Ship the customer package.' },
        { startMs: 30_000, endMs: 30_000 },
        [{ startMs: 30_000, text: 'Launch the unrelated campaign.' }]
      )
    ).toBeNull()
  })

  it('salvages the grounded clause in paraphrase mode when a bundled clause fails the quantity atom', () => {
    const records = sanitizeWriterRecords(
      'action_items',
      {
        title: 'Start Android RC release',
        content: 'Begin Android RC release today. Raise the trial price by 12%.'
      },
      { startMs: 10_000, endMs: 18_000 },
      [
        {
          startMs: 10_000,
          text: 'The Android RC finished testing, so I will start the release today.'
        },
        { startMs: 18_000, text: 'It passed QA.' }
      ],
      'paraphrase'
    )

    expect(records).toHaveLength(1)
    expect(records[0].content).toBe('Begin Android RC release today')
    expect(records[0].salvaged).toBe(true)
  })

  it('rejects a polarity flip in paraphrase mode', () => {
    expect(
      sanitizeWriterRecords(
        'information',
        { title: 'Rollout status', content: 'The rollout is not paused.' },
        { startMs: 10_000, endMs: 10_000 },
        [{ startMs: 10_000, text: 'The rollout is paused until the crash rate drops.' }],
        'paraphrase'
      )
    ).toEqual([])
  })

  it('grounds a correctly derived fractional difference in paraphrase mode', () => {
    // Real m2 spacings: the 6–7% neighbor starts 13.2s after the cited 30.88
    // line (1_933_154 − 1_919_906). Verbatim's 12s neighbor cap misses it;
    // paraphrase's 20s / 3-line window must pull it in.
    const records = sanitizeWriterRecords(
      'information',
      {
        title: 'Cancellation rate comparison',
        content:
          'The cancellation rate for users with full features is 30.88% versus 28.4% for those without, indicating a 2.48% absolute difference, or about 6–7% relative.'
      },
      { startMs: 1_919_906, endMs: 1_932_574 },
      [
        { startMs: 1_916_546, text: 'Um Yeah, the reason.' },
        {
          startMs: 1_919_906,
          text: "Oh you is it this number that you're showing me, the 30.88 versus 28.4. Yeah, so the the true, the true are are are that's the cancellation rate of people who got the full features. The false is the cancellation rate of people who did not get it."
        },
        {
          startMs: 1_933_154,
          text: "Uh well so two percent is is um Is larger than it seems, right? It's like six or seven percent relative, not absolute."
        },
        {
          startMs: 1_941_442,
          text: 'Okay. Well, I was I was trying to measure like the statistical significance using the mixed panel.'
        }
      ],
      'paraphrase'
    )

    expect(records.length).toBeGreaterThanOrEqual(1)
    expect(records[0]?.salvaged).not.toBe(true)
    expect(records[0]?.content).toContain('2.48')
  })
})
