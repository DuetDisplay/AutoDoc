import { describe, expect, it } from 'vitest'

import {
  parseExtractorMarkdown,
  renderVerifiedMarkdown,
  verifyCommitments
} from '../verify-commitments.ts'

const transcript = [
  'Alex: I will send the Orion soak report on Friday so QA can start.',
  'Blair: Please file the antenna ticket before freeze.',
  'Casey: We should consider a rewrite of the parser, maybe next quarter.',
  'Drew: We could try a new vendor for the clock boards.',
  'Eden: Left the local discovery review for Sam to handle.',
  'Ford: Most of the PRs are already ready for the build today.'
]

describe('extractor parse', () => {
  it('reads bold actions, real owners, and drops the Owner placeholder', () => {
    const items = parseExtractorMarkdown(
      [
        '* **Send the Orion soak report** (Alex) — So QA can start Friday.',
        '* **File the antenna ticket** (Owner)',
        '- **Rewrite the parser**'
      ].join('\n')
    )
    expect(items).toHaveLength(3)
    expect(items[0]?.action).toBe('Send the Orion soak report')
    expect(items[0]?.owner).toBe('Alex')
    expect(items[0]?.rationale).toBe('So QA can start Friday.')
    expect(items[1]?.owner).toBeNull()
    expect(items[2]?.owner).toBeNull()
  })
})

describe('commitment verify', () => {
  it('keeps grounded definite commitments and a real owner', () => {
    const result = verifyCommitments(
      '* **Send the Orion soak report** (Alex) — So QA can start Friday.\n',
      transcript
    )
    expect(result.kept).toHaveLength(1)
    expect(result.decisions[0]?.reason).toBe('kept')
    expect(result.kept[0]?.owner).toBe('Alex')
  })

  it('rejects an ungrounded action', () => {
    const result = verifyCommitments('* **Ship the helium balloon payload** (Owner)\n', transcript)
    expect(result.kept).toHaveLength(0)
    expect(result.decisions[0]?.reason).toBe('ungrounded')
  })

  it('strips an ungrounded owner and keeps the grounded action', () => {
    const result = verifyCommitments(
      '* **Send the Orion soak report** (Zed) — So QA can start Friday.\n',
      transcript
    )
    expect(result.kept).toHaveLength(1)
    expect(result.decisions[0]?.reason).toBe('kept')
    expect(result.kept[0]?.owner).toBeNull()
  })

  it('parses an Owner: prefix and keeps a grounded owner token', () => {
    const result = verifyCommitments(
      '* **Send the Orion soak report** (Owner: Alex) — So QA can start Friday.\n',
      transcript
    )
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.owner).toBe('Alex')
  })

  it('keeps a grounded owner from a mixed slot and drops the ungrounded one', () => {
    const result = verifyCommitments(
      '* **Send the Orion soak report** (Zed, Alex) — So QA can start Friday.\n',
      transcript
    )
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.owner).toBe('Alex')
  })

  it('rejects should/maybe/could/consider support without a definite override', () => {
    const shouldResult = verifyCommitments('* **Rewrite the parser** (Owner)\n', transcript)
    expect(shouldResult.decisions[0]?.reason).toBe('modality_promoted')
    const couldResult = verifyCommitments(
      '* **Try a new vendor for the clock boards** (Owner)\n',
      transcript
    )
    expect(couldResult.decisions[0]?.reason).toBe('modality_promoted')
  })

  it('does not let a weak non-hedged mention override hedged best support', () => {
    const result = verifyCommitments('* **Rewrite the parser** (Owner)\n', [
      ...transcript,
      'Alex: The parser file is in the repo.'
    ])
    expect(result.decisions[0]?.reason).toBe('modality_promoted')
  })

  it('keeps a handoff whose support is definite even if a hedge exists elsewhere', () => {
    const result = verifyCommitments(
      '* **Leave the local discovery review for Sam** (Owner)\n',
      transcript
    )
    expect(result.decisions[0]?.reason).toBe('kept')
  })

  it('rejects past-tense completion framed as a future action', () => {
    const bill = verifyCommitments('* **Get everything ready for the bill today** (Owner)\n', [
      'Eden: Yeah, for me, my main focus was to get everything ready for the bill today.'
    ])
    expect(bill.decisions[0]?.reason).toBe('past_completion')
    const reviewed = verifyCommitments("* **Review Norbert's PRs** (Owner)\n", [
      'Eden: And other than this, I also reviewed his PRs.'
    ])
    expect(reviewed.decisions[0]?.reason).toBe('past_completion')
    const already = verifyCommitments("* **Review Matt's PRs** (Owner)\n", [
      'Eden: Matt already reviewed most of them.'
    ])
    expect(already.decisions[0]?.reason).toBe('past_completion')
    const looking = verifyCommitments(
      '* **Look into the Consent to Analytics event and try to get a fix on it** (Owner)\n',
      ['Drew: I was looking into the Consent to Analytics event.']
    )
    expect(looking.decisions[0]?.reason).toBe('past_completion')
  })

  it('rejects might/worth/idea hedges unless a separate utterance confirms assignment', () => {
    const might = verifyCommitments('* **Ship the parser rewrite** (Owner)\n', [
      'Casey: We might ship the parser rewrite next quarter.'
    ])
    expect(might.decisions[0]?.reason).toBe('modality_promoted')
    const idea = verifyCommitments('* **Set up uptime status on the website** (Owner)\n', [
      'Drew: A lot of sites have an uptime status page.',
      'Eden: Do you think that it is a good idea?'
    ])
    expect(idea.decisions[0]?.reason).toBe('modality_promoted')
    const worth = verifyCommitments('* **Rewrite the parser in rust** (Owner)\n', [
      'Casey: It might be worth a rewrite of the parser in rust.'
    ])
    expect(worth.decisions[0]?.reason).toBe('modality_promoted')
  })

  it('keeps a hedged proposal when a separate utterance confirms go-ahead', () => {
    const result = verifyCommitments(
      '* **Research possibilities for better relay server deployment** (Owner)\n',
      [
        'Drew: I was thinking if we could research the possibilities for better relay server deployment.',
        'Eden: Okay, yeah, definitely go ahead and research if you can find something better.'
      ]
    )
    expect(result.decisions[0]?.reason).toBe('kept')
    expect(result.decisions[0]?.hedgeHits.length).toBeGreaterThan(0)
    expect(result.decisions[0]?.confirmationUtteranceCount).toBeGreaterThan(0)
  })

  it('rejects a deferred website-status idea even if the best support contains I will', () => {
    const result = verifyCommitments('* **Set up uptime status on the website** (Owner)\n', [
      'Drew: The other thing we could do is a public page.',
      'Drew: I will put the link in here. I do not know if that is quite ready to put on our website.',
      'Eden: Yeah, actually that is a good point, like uptime status.'
    ])
    expect(result.decisions[0]?.reason).toBe('modality_promoted')
    expect(result.kept).toHaveLength(0)
  })

  it('rejects a should-proposal in a neighboring turn without agreement', () => {
    const result = verifyCommitments(
      '* **Send additional messages if something is offline for a time period** (Owner)\n',
      [
        'Drew: Simply if something becomes unavailable, we should send additional messages if something was',
        'Drew: offline for a time period and exponentially growing.'
      ]
    )
    expect(result.decisions[0]?.reason).toBe('modality_promoted')
  })

  it('rejects a want-to-look status that is not a commitment', () => {
    const result = verifyCommitments('* **Review the color patch comments** (Owner)\n', [
      'Casey: I want to look at the comments on the color patch.'
    ])
    expect(result.decisions[0]?.reason).toBe('modality_promoted')
    expect(result.kept).toHaveLength(0)
  })

  it('renders survivors without the Owner placeholder', () => {
    const result = verifyCommitments(
      [
        '* **Send the Orion soak report** (Alex) — So QA can start Friday.',
        '* **Rewrite the parser** (Owner)'
      ].join('\n'),
      transcript
    )
    expect(renderVerifiedMarkdown(result.kept)).toBe(
      '* **Send the Orion soak report** (Alex) — So QA can start Friday.\n'
    )
  })
})
