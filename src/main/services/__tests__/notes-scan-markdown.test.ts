import { describe, expect, it } from 'vitest'
import { parseMeetingNotesContent } from '../notes-schema'
import { meetingSpanSources, parseScanMarkdown } from '../notes-scan-markdown'

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
