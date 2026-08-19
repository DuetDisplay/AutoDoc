import { describe, expect, it } from 'vitest'

describe('isPlausiblePersonOwner verb stoplist', () => {
  it('rejects common action verbs seen in generated next steps', () => {
    for (const junk of [
      'Assess',
      'Evaluate',
      'Investigate',
      'Implement',
      'Establish',
      'Adopt',
      'Adjusted',
      'Switch',
      'Finish'
    ]) {
      expect(isPlausiblePersonOwner(junk)).toBe(false)
    }
  })
})
import { parseMeetingNotesContent } from '../notes-schema'
import {
  isPlausiblePersonOwner,
  meetingSpanSources,
  parseScanMarkdown
} from '../notes-scan-markdown'

function parseNextSteps(markdown: string) {
  return parseScanMarkdown(`## Next Steps\n${markdown}`, {
    fallbackSources: [{ startMs: 0, endMs: 10 }]
  }).nextSteps
}

const FIR_LIKE = `# Entire screen

## Analytics and User Consent
- A fix is needed on the Consent to Analytics event.
 - Agreed: collect login events from all users, not just those with analytics enabled

## Next Steps
* **Review the offline analytics PR** (Norbert)
* **Send text message alerts in addition to Slack notifications** (Gabber)
`

describe('parseScanMarkdown', () => {
  it('maps topical parents, Agreed children, and one-line next steps', () => {
    const content = parseScanMarkdown(FIR_LIKE, {
      fallbackSources: [{ startMs: 1000, endMs: 2000 }]
    })

    expect(content.decisions).toEqual([])
    expect(content.sections).toHaveLength(1)
    expect(content.sections[0]?.title).toBe('Analytics and User Consent')
    expect(content.sections[0]?.keyPoints[0]?.text).toContain('Consent to Analytics')
    expect(content.sections[0]?.supportingDetails[0]?.text).toMatch(/^Agreed:/)
    expect(content.nextSteps).toHaveLength(2)
    expect(content.nextSteps[0]?.title).toBe('Review the offline analytics PR')
    expect(content.nextSteps[0]?.owner).toBe('Norbert')
    expect(content.nextSteps[0]?.sources).toEqual([{ startMs: 1000, endMs: 2000 }])
    expect(() => parseMeetingNotesContent(content)).not.toThrow()
  })

  it('omits an empty Decisions heading', () => {
    const content = parseScanMarkdown(
      `# Notes\n\n## Decisions\n\n## Next Steps\n* **Approve Cursor Access Request to GitHub** (Chris)\n`,
      { fallbackSources: [{ startMs: 0, endMs: 10 }] }
    )
    expect(content.sections).toEqual([])
    expect(content.decisions).toEqual([])
    expect(content.nextSteps[0]?.owner).toBe('Chris')
  })

  it('drops parenthetical fragments that are not person names', () => {
    const [step] = parseNextSteps('* **Confirm mirroring approach** (Determine, English)')
    expect(step?.title).toBe('Confirm mirroring approach')
    expect(step?.owner).toBeNull()
  })

  it.each(['Yeah', 'Them', 'We', 'User'])(
    'treats (%s) as a non-owner',
    (owner) => {
      const [step] = parseNextSteps(`* **Ship the notes parser** (${owner})`)
      expect(step?.title).toBe('Ship the notes parser')
      expect(step?.owner).toBeNull()
    }
  )

  it.each(['English', 'Determine', 'TBD', 'Team', 'Yeah', 'by Friday', '2026-08-20'])(
    'treats (%s) as a non-owner',
    (owner) => {
      const [step] = parseNextSteps(`* **Ship the notes parser** (${owner})`)
      expect(step?.title).toBe('Ship the notes parser')
      expect(step?.owner).toBeNull()
    }
  )

  it.each(['Chris', 'Norbert', 'Chris Jackson', "O'Brien", 'Anne-Marie'])(
    'keeps plausible person owner %s',
    (owner) => {
      const [step] = parseNextSteps(`* **Ship the notes parser** (${owner})`)
      expect(step?.title).toBe('Ship the notes parser')
      expect(step?.owner).toBe(owner)
    }
  )

  it('parses a next step with no parenthetical and a null owner', () => {
    const [step] = parseNextSteps('* **Write the release notes**')
    expect(step?.title).toBe('Write the release notes')
    expect(step?.owner).toBeNull()
  })

  it('still maps topical key points when next-step owners are gated', () => {
    const content = parseScanMarkdown(
      `## Analytics and User Consent\n- A fix is needed on the Consent to Analytics event.\n - Agreed: collect login events from all users\n\n## Next Steps\n* **Confirm mirroring approach** (Determine, English)\n`,
      { fallbackSources: [{ startMs: 0, endMs: 10 }] }
    )
    expect(content.sections).toHaveLength(1)
    expect(content.sections[0]?.title).toBe('Analytics and User Consent')
    expect(content.sections[0]?.keyPoints[0]?.title).toBe(
      'A fix is needed on the Consent to Analytics event.'
    )
    expect(content.sections[0]?.supportingDetails[0]?.text).toMatch(/^Agreed:/)
    expect(content.nextSteps[0]?.owner).toBeNull()
  })
})

describe('isPlausiblePersonOwner', () => {
  it('accepts 1–3 capitalized name tokens', () => {
    expect(isPlausiblePersonOwner('Chris')).toBe(true)
    expect(isPlausiblePersonOwner('Chris Jackson')).toBe(true)
    expect(isPlausiblePersonOwner("O'Brien")).toBe(true)
    expect(isPlausiblePersonOwner('Anne-Marie')).toBe(true)
    expect(isPlausiblePersonOwner('José')).toBe(true)
  })

  it('rejects empty, punctuated, numeric, and stoplist values', () => {
    expect(isPlausiblePersonOwner('')).toBe(false)
    expect(isPlausiblePersonOwner('   ')).toBe(false)
    expect(isPlausiblePersonOwner('Determine, English')).toBe(false)
    expect(isPlausiblePersonOwner('English')).toBe(false)
    expect(isPlausiblePersonOwner('2026-08-20')).toBe(false)
    expect(isPlausiblePersonOwner('Chris/Norbert')).toBe(false)
    expect(isPlausiblePersonOwner('Chris & Matt')).toBe(false)
    expect(isPlausiblePersonOwner('Team')).toBe(false)
    expect(isPlausiblePersonOwner('Yeah')).toBe(false)
    expect(isPlausiblePersonOwner('(Yeah)')).toBe(false)
    expect(isPlausiblePersonOwner('Them')).toBe(false)
    expect(isPlausiblePersonOwner('(Them)')).toBe(false)
    expect(isPlausiblePersonOwner('We')).toBe(false)
    expect(isPlausiblePersonOwner('(We)')).toBe(false)
    expect(isPlausiblePersonOwner('User')).toBe(false)
    expect(isPlausiblePersonOwner('(User)')).toBe(false)
    expect(isPlausiblePersonOwner('by Friday')).toBe(false)
  })
})

describe('meetingSpanSources', () => {
  it('uses the min start and max end', () => {
    expect(
      meetingSpanSources([
        { startMs: 40, endMs: 50 },
        { startMs: 10, endMs: 80 }
      ])
    ).toEqual([{ startMs: 10, endMs: 80 }])
  })
})
