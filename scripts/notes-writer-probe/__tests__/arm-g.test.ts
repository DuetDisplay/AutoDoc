import { describe, expect, it } from 'vitest'

import {
  agreedDecisionLine,
  applyArmG,
  dedupeClauses,
  dedupeSiblingChildren,
  evaluateArmGGates,
  groupFactCount,
  groupIsSubset,
  groupsPartialOverlap,
  isFillerSentence,
  isClosedDecision,
  isPastTenseCompleted,
  joinFragmentRun,
  leftoverFooterFacts,
  nsDuplicatesDecision,
  passFooterPresentation,
  parseActionBullet,
  parseBulletGroups,
  parseNotes,
  renderActionBullet,
  renderNotes,
  passClusterNs,
  passCrossGroupDedup,
  passFillerStrip,
  passFragmentFusion,
  passIdLeakRepair,
  passMisfiledChildren,
  passMotivationDrop,
  passNsVsDecisions,
  passPastTenseDemote,
  relatedByWorkstream,
  repairIdLeakLine,
  stripFillerText
} from '../arm-g.ts'
import { parseCoverageKey } from '../coverage.ts'

const duplicatedPostIncident = `# Entire screen

## Incident Response and Transparency
- Uptime status and incident resolution transparency benefits users
 - A post-incident report is added for every outage to clarify ownership of issues

## Decisions
* **Add transparency to uptime status and incident resolution process** — The team will add a post-incident report for every single outage, including the problem that occurred.

## Next Steps
* **Add transparency to uptime status and incident resolution process** — The team will add a post-incident report for every single outage, including the problem that occurred.
* **Review the local discovery PRs** (Matt) — So QA can start Friday.
`

const fillerTimeline = `# Entire screen

## Relay
- Relay servers need an endpoint that reports KPIs

## Decisions
* **Create ticket for relay update with endpoint reporting metrics.** — A task was assigned to create a ticket for updating the relay service with an endpoint that reports some key performance indicators (KPIs). This is crucial in monitoring and improving system efficiency. The exact timeline of prioritization remains unclear, but it's considered essential nonetheless.

## Next Steps
* **Update relay service with endpoint reporting metrics** — The team will work on updating the relay service to include an endpoint that reports key performance indicators (KPIs). This is a high-priority task aimed at improving system efficiency and user experience. The exact timeline of completion remains unclear, but it's considered essential nonetheless.
`

const smsSlack = `# Entire screen

## Notification Systems and Delivery
- Implement text message notifications alongside Slack to improve coverage, especially during nights and weekends
 - Current Slack setup fails to reach users off-hours or when phones are disconnected
 - Slack relies on user accessibility, leading to missed alerts during weekends and nights
 - Recent alert on Saturday morning was only seen by a few members, exposing shared ownership gaps

- SMS vs. Slack for downtime alerts
 - SMS offers broader reach but lacks context and team visibility
 - Slack enables team discussion but depends on user phone access

- Uptime Robot monitors endpoint uptime but does not detect all critical errors
 - May miss failures unrelated to service unavailability

## Decisions
* **Customize notification thresholds and channels for critical errors.** — Raise numbers to notify only when there are more than five issues per hour.

## Next Steps
* **Send text message alerts in addition to Slack notifications** (Gabber) — Gabber suggested adding text message alerts to ensure critical issues are noticed even on weekends.
`

const implementedSystem = `# Entire screen

## Relay Monitoring and Uptime
- Updated Relay Pool Monitoring System
 - Monitors relay server health
 - Votes on server availability
 - Assigns users to available nodes

## Decisions
* **Next Steps for Relay Pool Monitoring System Update** — Them will do another product release after this meeting.

## Next Steps
* **Implement a system to avoid assigning users to failed relay nodes** (Gabber) — rationale: Gabber implemented a system that monitors relay server health and avoids assigning users to failed nodes
* **Review proxy transport optimizations PR** — Matt asked the team to review his pull request.
`

const ownerPreserving = `# Entire screen

## Analytics
- Local discovery analytics needs a reviewer with context

## Decisions
* **Ship the Orion soak on Thursday** — We agreed to ship the Orion soak on Thursday.

## Next Steps
* **Ship the Orion soak on Thursday** (Alex) — We agreed to ship the Orion soak on Thursday.
`

const coverageKey = `| ID | Type | Granola claim (compressed) | Grounded | Transcript support | Notes |
|---|---|---|---|---|---|
| K1 | context | Post-incident report for every outage | yes | ~00:01 | |
| K2 | metric | Invented 12 widgets | **no** | not in transcript | Exclude. |
| K3 | commitment | Review the local discovery PRs (Matt) | yes | ~00:02 | |
`

describe('Arm G parsers', () => {
  it('reads a trailing decision owner and a leading NS owner', () => {
    const decision = parseActionBullet(
      '* **Assign local Discovery Analytics PR to Chris for review.** — Chris will take over reviewing. (Chris)'
    )
    expect(decision.title).toContain('Assign local Discovery')
    expect(decision.owners).toEqual(['Chris'])
    const ns = parseActionBullet(
      '* **Review the local discovery PRs** (Matt) — rationale: Matt requested a review'
    )
    expect(ns.owners).toEqual(['Matt'])
    expect(ns.body.startsWith('rationale:')).toBe(true)
  })

  it('parses indented children as one bullet group', () => {
    const groups = parseBulletGroups(
      [
        '- Implement text message notifications alongside Slack',
        ' - Current Slack setup fails to reach users',
        ' - Slack relies on user accessibility',
        '',
        '- SMS vs. Slack for downtime alerts',
        ' - SMS offers broader reach but lacks context'
      ].join('\n')
    )
    expect(groups).toHaveLength(2)
    expect(groups[0]?.children).toHaveLength(2)
    expect(groups[1]?.title).toMatch(/SMS vs\. Slack/)
  })
})

describe('Arm G pass 1 NS-vs-Decisions', () => {
  it('drops the duplicated post-incident-report Next Step and keeps the Decision', () => {
    const { doc, changes } = passNsVsDecisions(parseNotes(duplicatedPostIncident))
    expect(nsDuplicatesDecision(doc.decisions[0]!, parseNotes(duplicatedPostIncident).nextSteps[0]!)).toBe(true)
    expect(doc.nextSteps.map((item) => item.title)).not.toContain(
      'Add transparency to uptime status and incident resolution process'
    )
    expect(doc.decisions.some((item) => /post-incident report/i.test(item.title + item.body))).toBe(true)
    expect(doc.nextSteps.some((item) => item.owners.includes('Matt'))).toBe(true)
    expect(changes.some((change) => change.action === 'keep-decision-drop-ns')).toBe(true)
  })

  it('keeps the Next Step and drops the Decision when only NS carries the owner', () => {
    const { doc, changes } = passNsVsDecisions(parseNotes(ownerPreserving))
    expect(doc.nextSteps).toHaveLength(1)
    expect(doc.nextSteps[0]?.owners).toEqual(['Alex'])
    expect(doc.decisions).toHaveLength(0)
    expect(changes.some((change) => change.action === 'keep-ns-drop-decision')).toBe(true)
  })
})

const notesRefactorSource = `# AutoDoc

## Notes
- Notes logic limited by user count

## Decisions
* **Use Gabber's system to send emails through Brevo** — The team will use Gabber's workflow.

## Next Steps
* **Refactor notes logic** — is currently working on refactoring the meeting note-taking system, which will make it easier and more efficient for users like Raoul's group.
* **Test notes logic with internal release** — plans to create an internal version of the updated meeting note-taking system for testing purposes, which will allow Raoul's group and others to provide feedback before a public launch.
* **Record stand-ups, one-on-ones, and meetings to gather diverse use cases** — to evaluate the new notes logic in real-world scenarios
* **Release an internal version of the notes refactor to Greg and Raul for feedback** — to allow them to test and provide input before a public launch
* **Test the new notes logic on a week's worth of meetings and gather feedback** — to evaluate performance and usability with real data before finalizing the release
`

const emailCampaignSource = `# AutoDoc

## Brevo
- Brevo campaign deemed infeasible due to 334 batches

## Decisions
* **Use Gabber's system to send emails through Brevo** — The team will use Gabber's workflow and limit the email sending rate.

## Next Steps
* **Review and approve email campaign content** — will send a test email to , who should review, comment on changes if needed.
* **to give email content to Gabber for integration into workflow** — will take care of the rest, including tuning and sending emails through Brevo's system.
* **Next Steps for Greg's Task** — Greg will talk to Chris tomorrow about standing up the Brevo email campaign.
* **Ensure the email campaign is configured to send no more than 1,500 emails per day** — to stay within Brevo’s monthly email limit and avoid additional costs
`

const m2Pass2Source = `# AutoDoc

## Brevo Campaign Feasibility
- Brevo campaign deemed infeasible due to 334 batches needed for over one million email addresses
 - Gabber has access to groups via Brevo through his own system

## Notes System Limitations
- Notes logic limited by user count

## Decisions
* **Remove Personal GitHub from Organization** (Chris) — will remove the blackjack130 personal GitHub repository from AutoDoc organization.
* **Use Gabber's system to send emails through Brevo** — The team will use Gabber's workflow and limit the email sending rate.

## Next Steps
* **Approve Cursor Access Request to GitHub** (Chris) — will approve the cursor access request if it was previously requested and approved.
* **Review and approve email campaign content** — will send a test email to , who should review, comment on changes if needed.
* **to give email content to Gabber for integration into workflow** — will take care of the rest, including tuning and sending emails through Brevo's system.
* **Refactor notes logic** — is currently working on refactoring the meeting note-taking system, which will make it easier and more efficient for users like Raoul's group.
* **Test notes logic with internal release** — plans to create an internal version of the updated meeting note-taking system for testing purposes, which will allow Raoul's group and others to provide feedback before a public launch.
* **Next Steps for Greg's Task** — Greg will talk to Chris tomorrow about standing up the Brevo email campaign.
* **Ensure the email campaign is configured to send no more than 1,500 emails per day** — to stay within Brevo’s monthly email limit and avoid additional costs
* **Record stand-ups, one-on-ones, and meetings to gather diverse use cases** — to evaluate the new notes logic in real-world scenarios
* **Release an internal version of the notes refactor to Greg and Raul for feedback** — to allow them to test and provide input before a public launch
* **Test the new notes logic on a week's worth of meetings and gather feedback** — to evaluate performance and usability with real data before finalizing the release
`

function isTokenSalad(body: string): boolean {
  if (body.trim().length === 0) return false
  const parts = body.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 3) return false
  return parts.every((part) => part.split(/\s+/u).length <= 3)
}

describe('Arm G pass 2 within-NS clustering', () => {
  it('merges the M2 notes-refactor workstream into one deliverable', () => {
    const { doc, changes } = passClusterNs(parseNotes(notesRefactorSource))
    expect(doc.nextSteps).toHaveLength(1)
    expect(doc.nextSteps[0]?.title).toMatch(/Greg|Raul|internal|notes refactor|week/i)
    expect(doc.nextSteps[0]?.body.split('\n')).toHaveLength(1)
    expect(isTokenSalad(doc.nextSteps[0]?.body ?? '')).toBe(false)
    expect(changes.some((change) => change.action === 'merge-ns-cluster')).toBe(true)
  })

  it('splits the M2 email workstream into two owner-and-verb deliverables', () => {
    const { doc } = passClusterNs(parseNotes(emailCampaignSource))
    expect(doc.nextSteps).toHaveLength(2)
    const review = doc.nextSteps.find((item) => /review|approv|test email/i.test(`${item.title} ${item.body}`))
    const configure = doc.nextSteps.find((item) => /1500|1,500|gabber|integrat|configur/i.test(`${item.title} ${item.body}`))
    expect(review).toBeTruthy()
    expect(configure).toBeTruthy()
    expect(`${review?.title} ${review?.body}`).toMatch(/test email/i)
    expect(isTokenSalad(review?.body ?? '')).toBe(false)
    expect(isTokenSalad(configure?.body ?? '')).toBe(false)
  })

  it('reduces the full M2 Next Steps set to four deliverables', () => {
    const { doc } = passClusterNs(parseNotes(m2Pass2Source))
    expect(doc.nextSteps).toHaveLength(4)
    expect(doc.nextSteps.some((item) => /cursor/i.test(item.title))).toBe(true)
    expect(doc.nextSteps.some((item) => /test email/i.test(`${item.title} ${item.body}`))).toBe(true)
    expect(doc.nextSteps.some((item) => /1500|1,500/i.test(`${item.title} ${item.body}`))).toBe(true)
    expect(doc.nextSteps.filter((item) => /notes|refactor/i.test(item.title))).toHaveLength(1)
    expect(doc.nextSteps.every((item) => !isTokenSalad(item.body))).toBe(true)
  })

  it('keeps iPad from a merged-away GUID sibling on the surviving item', () => {
    const { doc } = passClusterNs(
      parseNotes(`# Title

## Topic
- GUID collisions on mobile

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Investigate and resolve Mix Panel GUID limit issues** (Matt) — Matt observed that QA users hit the 500 GUID limit
* **Investigate iPad identify errors** (Matt) — Matt identified recurring identify errors on iPad due to GUID collisions
`)
    )
    expect(doc.nextSteps).toHaveLength(1)
    expect(`${doc.nextSteps[0]?.title} ${doc.nextSteps[0]?.body}`).toMatch(/iPad/)
  })

  it('does not merge items that only share an owner plus weak process words', () => {
    const android = parseActionBullet(
      '* **Update Android app to Android 16 and new billing library** (Norbert) — Norbert confirmed Google required the update and set an RC build for QA, with issues to be addressed before the August deadline'
    )
    const logFile = parseActionBullet(
      '* **Investigate the user-submitted log file** (Norbert) — Norbert stated he reached out to the user after finding no context in the log file and confirmed the investigation'
    )
    expect(relatedByWorkstream(android, logFile)).toBe(false)

    const mixpanelDetect = parseActionBullet(
      '* **Investigate using MixPanels for detecting critical errors and sending notifications** — The team should explore integrating with MixPanel to detect issues in real-time.'
    )
    const alertsChannel = parseActionBullet(
      '* **Add team members to Alerts Duet Services channel and set up notifications for critical errors** — Most everybody should be in the Alerts channel.'
    )
    expect(relatedByWorkstream(mixpanelDetect, alertsChannel)).toBe(false)
  })

  it('does not merge unrelated review items that only share a generic verb', () => {
    const left = parseActionBullet('* **Review the offline analytics PR** (Norbert) — Norbert stated he has one more PR to review')
    const right = parseActionBullet('* **Review the RC build issues** — Them will review the RC build, QA has reported two issues')
    expect(relatedByWorkstream(left, right)).toBe(false)
    const { doc } = passClusterNs(
      parseNotes(`# Title

## Topic
- Unrelated reviews

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Review the offline analytics PR** (Norbert) — Norbert stated he has one more PR to review, which is the offline analytics PR
* **Review the RC build issues** — Them will review the RC build, QA has reported two issues that need to be addressed before release by end of August.
`)
    )
    expect(doc.nextSteps).toHaveLength(2)
  })

  it('merges overlapping NS items and unions owners', () => {
    const source = `# Title

## Topic
- Uptime Robot dashboard visibility

## Decisions
* **Keep the dashboard** — Stay on Uptime Robot.

## Next Steps
* **Add team members to the Uptime Robot dashboard** — will add users on the Uptime Robot account.
* **Add all relevant team members to the Uptime Robot dashboard** (Gabber) — Gabber proposed adding all team members to the Uptime Robot dashboard.
* **Review proxy transport optimizations PR** — Separate follow-up.
`
    const { doc, changes } = passClusterNs(parseNotes(source))
    expect(doc.nextSteps).toHaveLength(2)
    const merged = doc.nextSteps.find((item) => /uptime robot/i.test(item.title + item.body))
    expect(merged?.owners).toContain('Gabber')
    expect(changes.some((change) => change.action === 'merge-ns-cluster')).toBe(true)
  })
})

describe('Arm G pass 3 filler strip', () => {
  it('strips the twice-occurring exact-timeline filler and rationale prefixes', () => {
    expect(
      isFillerSentence('The exact timeline of completion remains unclear, but it\'s considered essential nonetheless.')
    ).toBe(true)
    expect(isFillerSentence('This is a high-priority task aimed at improving system efficiency and user experience.')).toBe(
      true
    )
    expect(isFillerSentence('Gabber implemented a system that monitors relay server health.')).toBe(false)

    const strippedDecision = stripFillerText(
      'A task was assigned to create a ticket for updating the relay service with an endpoint that reports some key performance indicators (KPIs). This is crucial in monitoring and improving system efficiency. The exact timeline of prioritization remains unclear, but it\'s considered essential nonetheless.',
      'Create ticket for relay update with endpoint reporting metrics.'
    )
    expect(strippedDecision).toMatch(/KPIs/)
    expect(strippedDecision).not.toMatch(/exact timeline/)
    expect(strippedDecision).not.toMatch(/considered essential/)

    const { doc } = passFillerStrip(parseNotes(fillerTimeline))
    const joined = `${doc.decisions.map((item) => item.body).join(' ')}\n${doc.nextSteps.map((item) => item.body).join(' ')}`
    expect(joined.match(/exact timeline/gi)?.length ?? 0).toBe(0)
    expect(joined).toMatch(/KPIs/)
  })
})

describe('Arm G pass 4 past-tense demotion', () => {
  it('drops an implemented-system NS item whose facts already live in the body', () => {
    const parsed = parseNotes(implementedSystem)
    expect(isPastTenseCompleted(parsed.nextSteps[0]!)).toBe(true)
    const { doc, changes } = passPastTenseDemote(parsed)
    expect(doc.nextSteps.map((item) => item.title).join(' ')).not.toMatch(/failed relay nodes/)
    expect(doc.nextSteps.some((item) => /proxy transport/i.test(item.title))).toBe(true)
    expect(changes.some((change) => change.action === 'drop-completed-ns')).toBe(true)
  })
})

describe('Arm G pass 5 cross-group body dedup', () => {
  it('catches the SMS vs Slack group as a restatement of the text-message group', () => {
    const parsed = parseNotes(smsSlack)
    const [textMessage, smsVsSlack] = parsed.topical[0]?.groups ?? []
    expect(textMessage?.title).toMatch(/text message/)
    expect(smsVsSlack?.title).toMatch(/SMS vs/)
    expect(groupIsSubset(smsVsSlack!, textMessage!) || groupsPartialOverlap(smsVsSlack!, textMessage!)).toBe(true)

    const { doc, changes } = passCrossGroupDedup(parsed)
    const titles = doc.topical[0]?.groups.map((group) => group.title) ?? []
    expect(titles.some((title) => /SMS vs\. Slack/i.test(title))).toBe(false)
    expect(titles.some((title) => /text message notifications/i.test(title))).toBe(true)
    const merged = doc.topical[0]?.groups.find((group) => /text message notifications/i.test(group.title))
    expect(merged?.children.join(' ')).toMatch(/SMS/)
    expect(changes.some((change) => change.action === 'delete-subset-group' || change.action === 'merge-overlap-groups')).toBe(
      true
    )
  })
})

describe('Arm G pipeline guards', () => {
  it('applies every pass and preserves coverage, names, and owners on the M1-pattern fixture', () => {
    const fixture = `# Entire screen

## Notification Systems and Delivery
- Implement text message notifications alongside Slack to improve coverage, especially during nights and weekends
 - Current Slack setup fails to reach users off-hours or when phones are disconnected
 - Slack relies on user accessibility, leading to missed alerts during weekends and nights
 - Recent alert on Saturday morning was only seen by a few members, exposing shared ownership gaps

- SMS vs. Slack for downtime alerts
 - SMS offers broader reach but lacks context and team visibility
 - Slack enables team discussion but depends on user phone access

## Incident Response and Transparency
- Uptime status and incident resolution transparency benefits users
 - A post-incident report is added for every outage to clarify ownership of issues

## Relay Monitoring and Uptime
- Updated Relay Pool Monitoring System
 - Monitors relay server health
 - Assigns users to available nodes

## Decisions
* **Add transparency to uptime status and incident resolution process** — The team will add a post-incident report for every single outage, including the problem that occurred.
* **Create ticket for relay update with endpoint reporting metrics.** — A task was assigned to create a ticket for updating the relay service with an endpoint that reports some key performance indicators (KPIs). The exact timeline of prioritization remains unclear, but it's considered essential nonetheless.

## Next Steps
* **Add transparency to uptime status and incident resolution process** — The team will add a post-incident report for every single outage, including the problem that occurred.
* **Update relay service with endpoint reporting metrics** — The team will work on updating the relay service to include an endpoint that reports key performance indicators (KPIs). The exact timeline of completion remains unclear, but it's considered essential nonetheless.
* **Implement a system to avoid assigning users to failed relay nodes** (Gabber) — rationale: Gabber implemented a system that monitors relay server health and avoids assigning users to failed nodes
* **Review the local discovery PRs** (Matt) — rationale: Matt requested that the PRs related to local discovery be reviewed by the team
`

    const result = applyArmG(fixture)
    expect(result.report.passes.map((pass) => pass.name)).toEqual([
      'id-leak-repair',
      'ns-vs-decisions',
      'within-ns-cluster',
      'filler-strip',
      'past-tense-demotion',
      'misfiled-child-repair',
      'fragment-fusion',
      'motivation-drop',
      'cross-group-body-dedup',
      'sibling-paraphrase',
      'footer-presentation'
    ])
    expect(result.report.smsSlackCaught).toBe(true)
    expect(result.report.nsGroupingPath).toBe('deterministic')
    expect(result.report.nextStepsAfter).toBeGreaterThan(0)
    expect(result.markdown).not.toMatch(/## Decisions/)
    expect(result.markdown).toMatch(/## Next Steps/)
    for (const line of result.markdown.split('\n')) {
      if (/^\*\s+\*\*/u.test(line)) expect(line).not.toMatch(/ — /)
    }
    expect(result.markdown).toMatch(/\* \*\*Review the local discovery PRs\*\* \(Matt\)/)
    expect(result.markdown).not.toMatch(/SMS vs\. Slack/)
    expect(result.markdown).toMatch(/\bSMS\b/)
    expect(result.markdown).not.toMatch(/exact timeline/)

    const items = parseCoverageKey(coverageKey)
    const gates = evaluateArmGGates(fixture, result.markdown, items)
    expect(gates.namesNumbersPass).toBe(true)
    expect(gates.ownersPass).toBe(true)
    expect(gates.structurePass).toBe(true)
    expect(gates.coveragePass).toBe(true)
    expect(gates.missingOwners).toEqual([])
  })
})

describe('Arm G general repair rules', () => {
  it('rebuilds a grammatical line after stripping an ID-as-subject', () => {
    const leaked = '- i03 indicates a need for a fix on the Orion soak event and states the fix will likely be attempted'
    expect(repairIdLeakLine(leaked, {})).toBe(
      '- A fix is needed on the Orion soak event and will likely be attempted.'
    )
    expect(repairIdLeakLine(leaked, {})).not.toMatch(/\bi03\b/)

    const { doc } = passIdLeakRepair(
      parseNotes(`# Title

## Analytics
- i03 indicates a need for a fix on the Orion soak event and states the fix will likely be attempted

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Ship the soak** — Thursday.
`)
    )
    const joined = doc.topical.flatMap((section) => section.groups.map((group) => group.title)).join('\n')
    expect(joined).toBe('A fix is needed on the Orion soak event and will likely be attempted.')
    expect(joined).not.toMatch(/\bi03\b/)
  })

  it('falls back to catalog text when the stripped ID line has no verb', () => {
    const leaked = '- i03 indicates'
    const catalog = {
      i03: 'The Orion soak event fires before the user consents so it measures wrong.'
    }
    expect(repairIdLeakLine(leaked, catalog)).toMatch(/fires before the user consents/i)
    expect(repairIdLeakLine(leaked, catalog)).not.toMatch(/\bi03\b/)
  })

  it('moves a whole group when its title overlaps another section heading, never a child', () => {
    const { doc } = passMisfiledChildren(
      parseNotes(`# Title

## Hosting
- Wildlife corridor survey
 - Remains unpublished
 - Needs a ranger
- Relay pool health
 - Votes on server availability
 - Zebra habitat survey remains unpublished

## Wildlife
- Pond pH

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Ship the soak** — Thursday.
`)
    )
    const wildlife = doc.topical.find((section) => /wildlife/i.test(section.name))
    const hosting = doc.topical.find((section) => /hosting/i.test(section.name))
    const moved = wildlife?.groups.find((group) => /wildlife corridor/i.test(group.title))
    expect(moved?.children.join(' ')).toMatch(/remains unpublished/i)
    expect(moved?.children.join(' ')).toMatch(/needs a ranger/i)
    expect(hosting?.groups.some((group) => /wildlife corridor/i.test(group.title))).toBe(false)
    const relay = hosting?.groups.find((group) => /relay pool/i.test(group.title))
    expect(relay?.children.join(' ')).toMatch(/zebra habitat/i)
    expect(doc.topical.flatMap((section) => section.groups).some((group) => /zebra habitat/i.test(group.title))).toBe(
      false
    )
  })

  it('drops a near-subset duplicate clause and keeps the owner-attributed one', () => {
    const kept = dedupeClauses([
      'Them will review the RC build, QA has reported two issues that need to be addressed before release by end of August; Norbert confirmed Google required the update and set an RC build for QA, with issues to be addressed before the August deadline'
    ])
    expect(kept.join(' ')).toMatch(/Norbert|Google/)
    expect(kept.join(' ')).toMatch(/two issues|RC build/)
    expect(kept.join(' ')).toMatch(/two issues that need to be addressed/i)
    expect(kept.join(' ')).not.toMatch(/with issues to be addressed/i)
  })

  it('fuses consecutive fact-free fragments and drops a covered motivation group', () => {
    const fused = passFragmentFusion(
      parseNotes(`# Title

## Hosting
- Staging rollout
 - Deployed to staging
 - Works well in staging
 - Still has issues

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Ship the soak** — Thursday.
`)
    )
    const staging = fused.doc.topical[0]?.groups[0]
    expect(staging?.children).toHaveLength(1)
    expect(staging?.children[0]).toMatch(/deployed to staging/i)
    expect(staging?.children[0]).toMatch(/but/)

    const dropped = passMotivationDrop(
      parseNotes(`# Title

## Hosting
- Outage impact
 - Significantly affects user experience
 - Requires immediate alerts

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Implement real-time alerts for server downtime** — Immediate alerts avoid user churn.
`)
    )
    expect(dropped.doc.topical[0]?.groups.some((group) => /outage impact/i.test(group.title))).toBe(false)

    const keptConstraint = passMotivationDrop(
      parseNotes(`# Title

## Hosting
- Orion soak limited by user count
 - Hinders performance testing and refinement

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Release the Orion soak** — Evaluate the new soak logic in real-world scenarios.
`)
    )
    expect(keptConstraint.doc.topical[0]?.groups.some((group) => /limited by user count/i.test(group.title))).toBe(
      true
    )
  })

  it('does not promote a child or drop a parent while keeping children', () => {
    const { doc } = passMisfiledChildren(
      parseNotes(`# Title

## Hosting
- Orion soak limited by user count
 - Hinders performance testing and refinement

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Ship the soak** — Thursday.
`)
    )
    const parent = doc.topical[0]?.groups.find((group) => /limited by user count/i.test(group.title))
    expect(parent?.children.join(' ')).toMatch(/hinders performance/i)
    expect(doc.topical[0]?.groups.some((group) => /hinders performance/i.test(group.title))).toBe(false)
  })

  it('drops a cross-section near-subset group and keeps the survivor by heading lemmas', () => {
    const { doc } = passCrossGroupDedup(
      parseNotes(`# Title

## Notifications
- No deployment timeline for QA testing
 - No clear timeline for QA deployment

## Launch systems
- Launch Darkly remains unpublished
 - Not deployed
 - No update since yesterday
 - No deployment timeline for QA testing

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Ship the soak** — Thursday.
`)
    )
    const titles = doc.topical.flatMap((section) => section.groups.map((group) => group.title))
    expect(titles.filter((title) => /launch darkly|deployment timeline/i.test(title))).toHaveLength(1)
    const launchSection = doc.topical.find((section) => /launch systems/i.test(section.name))
    expect(launchSection?.groups.some((group) => /launch darkly/i.test(group.title))).toBe(true)
    const notify = doc.topical.find((section) => /notification/i.test(section.name))
    expect(notify?.groups.some((group) => /deployment timeline/i.test(group.title))).toBe(false)
  })

  it('removes a section heading that has no remaining groups', () => {
    const result = applyArmG(`# Title

## Hosting
- Soak is live

## Wildlife

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Ship the soak** — Thursday.
`)
    expect(result.markdown).toMatch(/## Hosting/)
    expect(result.markdown).not.toMatch(/## Wildlife/)
  })

  it('drops a near-subset sibling and keeps the more specific earlier line', () => {
    const kept = dedupeSiblingChildren([
      'No clear timeline for QA deployment',
      'No deployment timeline for QA testing',
      'Launch Darkly team reports unchanged state since yesterday',
      'Not deployed and team member has no update since yesterday'
    ])
    expect(kept.filter((line) => /timeline/i.test(line))).toHaveLength(1)
    expect(kept.filter((line) => /yesterday|not deployed/i.test(line))).toHaveLength(1)
    expect(kept.some((line) => /launch darkly team reports/i.test(line))).toBe(true)
    expect(kept.some((line) => /no clear timeline/i.test(line))).toBe(true)
  })

  it('does not lowercase a proper name or acronym when joining fragments', () => {
    expect(joinFragmentRun(['Current Slack setup fails', 'Slack relies on user accessibility'])).toMatch(
      /and Slack relies/
    )
    expect(joinFragmentRun(['Batch function failed', 'Gabber has access to groups'])).toMatch(/and Gabber has/)
    expect(joinFragmentRun(['Endpoint is down', 'SMS offers broader reach'])).toMatch(/and SMS offers/)
  })

  it('elides a repeated leading predicate phrase of at least two tokens', () => {
    expect(
      joinFragmentRun(['Focus is on resolving service downtime', 'Focus is on improving system efficiency'])
    ).toBe('Focus is on resolving service downtime and improving system efficiency')
  })

  it('chooses the parent with more distinct names and numbers', () => {
    const brevo = {
      title: 'Brevo campaign deemed infeasible due to 334 batches needed for over one million email addresses',
      children: ['Gabber has access to groups via Brevo through his own system']
    }
    const greg = {
      title: "Next Steps for Greg's Task",
      children: ['Greg to discuss standing up Brevo email campaign with Chris tomorrow']
    }
    expect(groupFactCount(brevo)).toBeGreaterThan(groupFactCount(greg))
    const result = applyArmG(`# Title

## Brevo Campaign Feasibility
- Brevo campaign deemed infeasible due to 334 batches needed for over one million email addresses
 - Gabber has access to groups via Brevo through his own system

## Task Progress and Next Steps
- Next Steps for Greg's Task
 - Greg to discuss standing up Brevo email campaign with Chris tomorrow

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Ship the soak** — Thursday.
`)
    const brevoSection = parseNotes(result.markdown).topical.find((section) => /brevo/i.test(section.name))
    expect(brevoSection?.groups.some((group) => /334|infeasible/i.test(group.title))).toBe(true)
    expect(result.markdown).not.toMatch(/^- Next Steps for Greg's Task/m)
  })

  it('repairs the real M1 leak, misfile, Android clauses, and staging fragments', () => {
    const source = `# Entire screen

## Notification Systems and Delivery
- No deployment timeline for QA testing
 - No clear timeline for QA deployment

## Relay Monitoring and Uptime
- Updated Relay Pool Monitoring System
 - Monitors relay server health
 - Deployed to staging environment
 - Works well in staging
 - Still has issues

- Adopting Periscope's Dashboard
 - Them and Peter discussed adopting a dashboard similar to Periscope's
 - Provides more information
 - Easy to interpret

- Relay downtime impact
 - Significantly affects user experience
 - Requires immediate alerts

- Current relay status and next steps
 - Launch Darkly team reports unchanged state since yesterday
 - No clear timeline for QA deployment
 - Launch Darkly remains in development

## Analytics and User Consent
- i03 indicates a need for a fix on the Consent to Analytics event and states the fix will likely be attempted

## Android Build and QA
- Android build update requirements from Google:
 - Must upgrade to Android 16
 - Must update billing library
 - Deadline: end of August
 - No hard consequences for missing deadline (app not removed)

- Android build status and QA feedback:
 - RC build released to QA
 - Two issues reported; need resolution before release
 - Includes bug fixes
 - Includes user experience improvements

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Update Android app to Android 16 and new billing library** (Norbert) — Them will review the RC build, QA has reported two issues that need to be addressed before release by end of August; Norbert confirmed Google required the update and set an RC build for QA, with issues to be addressed before the August deadline
* **Implement real-time alerts for relay server downtime** (Gabber) — Immediate alerts avoid user churn.
`
    const result = applyArmG(source, {
      sourceCatalog: {
        i03: 'The Consent to Analytics event fires before the user consents so it measures wrong, and a fix will likely be attempted for the release.'
      }
    })
    expect(result.markdown).not.toMatch(/\bi03\b/)
    expect(result.markdown).not.toMatch(/## Notification Systems and Delivery\n## /)
    expect(result.markdown).not.toMatch(/## Notification Systems and Delivery\n## /)
    expect(result.markdown).toMatch(
      /A fix is needed on the Consent to Analytics event and will likely be attempted/
    )
    const parsed = parseNotes(result.markdown)
    const titles = parsed.topical.flatMap((section) => section.groups.map((group) => group.title))
    expect(titles.filter((title) => /^Provides more information$/i.test(title))).toHaveLength(0)
    expect(titles.filter((title) => /^Easy to interpret$/i.test(title))).toHaveLength(0)
    expect(titles.filter((title) => /^Requires immediate alerts$/i.test(title))).toHaveLength(0)
    const periscope = parsed.topical
      .flatMap((section) => section.groups)
      .find((group) => /periscope/i.test(group.title))
    expect(periscope?.children.join(' ')).toMatch(/provides more information/i)
    expect(periscope?.children.join(' ')).toMatch(/easy to interpret/i)
    const androidGroups = parsed.topical.find((section) => /android/i.test(section.name))?.groups ?? []
    expect(
      androidGroups.some((group) => /significantly affects/i.test(`${group.title} ${group.children.join(' ')}`))
    ).toBe(false)
    const requirements = androidGroups.find((group) => /requirements from google/i.test(group.title))
    if (requirements) {
      expect(requirements.children.join(' ')).toMatch(/deadline: end of august/i)
    }
    expect(result.markdown).toMatch(/Launch Darkly/)
    expect(result.markdown).toMatch(/deployed to staging/i)
    expect(result.markdown).toMatch(/but/)
    const android = result.markdown.match(/\* \*\*Update Android[\s\S]*?(?=\n\* |\n## )/)?.[0] ?? ''
    expect(android).toMatch(/Norbert/)
    expect(android).not.toMatch(/ — /)
    expect(result.markdown).toMatch(/two issues/i)
    expect(android).not.toMatch(/with issues to be addressed/i)
  })
})

describe('Arm G footer presentation', () => {
  it('reclassifies a future-tense Decision to Next Steps', () => {
    const source = `# Title

## Soak
- Orion soak ships Thursday

## Decisions
* **Ship the Orion soak** — The team will ship the Orion soak on Thursday.

## Next Steps
* **Review the local discovery PRs** (Alex)
`
    const { doc } = passFooterPresentation(parseNotes(source))
    expect(isClosedDecision(parseNotes(source).decisions[0]!)).toBe(false)
    expect(doc.decisions.map((item) => item.title)).not.toContain('Ship the Orion soak')
    expect(doc.nextSteps.some((item) => item.title === 'Ship the Orion soak')).toBe(true)
  })

  it('reclassifies an owner-bearing Decision to Next Steps', () => {
    const source = `# Title

## Soak
- Orion soak ships Thursday

## Decisions
* **Ship the Orion soak** (Alex) — Ship Thursday.

## Next Steps
* **Review the local discovery PRs**
`
    const { doc } = passFooterPresentation(parseNotes(source))
    expect(doc.decisions.map((item) => item.title)).not.toContain('Ship the Orion soak')
    const moved = doc.nextSteps.find((item) => item.title === 'Ship the Orion soak')
    expect(moved?.owners).toContain('Alex')
  })

  it('inlines a closed-policy Decision as an Agreed child under the overlapping topic', () => {
    const source = `# Title

## Analytics
- Login events are collected from every user

## Decisions
* **Login event data collection decision** — The team decided to collect login events from all users, not just those with analytics enabled.

## Next Steps
* **Review the local discovery PRs** (Alex)
`
    expect(isClosedDecision(parseNotes(source).decisions[0]!)).toBe(true)
    expect(agreedDecisionLine(parseNotes(source).decisions[0]!)).toBe(
      'Agreed: collect login events from all users, not just those with analytics enabled'
    )
    const { doc } = passFooterPresentation(parseNotes(source))
    expect(doc.decisions).toHaveLength(0)
    const analytics = doc.topical.find((section) => /analytics/i.test(section.name))
    const children = analytics?.groups.flatMap((group) => group.children) ?? []
    expect(children.some((line) => /^Agreed: collect login events from all users/i.test(line))).toBe(true)
    expect(doc.nextSteps.some((item) => /login event/i.test(item.title))).toBe(false)
  })

  it('omits the Decisions heading after inlining closed choices', () => {
    const source = `# Title

## Analytics
- Login events are collected from every user

## Decisions
* **Login event data collection decision** — The team decided to collect login events from everyone.

## Next Steps
* **Review the local discovery PRs** (Alex)
`
    const { doc } = passFooterPresentation(parseNotes(source))
    expect(renderNotes(doc)).not.toMatch(/## Decisions/)
    expect(renderNotes(doc)).toMatch(/## Next Steps/)
    const gates = evaluateArmGGates(source, renderNotes(doc), parseCoverageKey(coverageKey))
    expect(gates.hasDecisions).toBe(false)
    expect(gates.structurePass).toBe(true)
  })

  it('attaches an escalation Decision under the incident heading, not an analytics leftover lemma', () => {
    const source = `# Title

## Analytics
- Weekend event counts are reviewed; a fix will likely be attempted

## Incident Response and Escalation
- Outages need a clear owner when someone is tagged
- The current escalation process is inefficient

## Decisions
* **Login event data collection decision** — The team decided to collect login events from all users, not just those with analytics enabled.
* **Tagging and Escalation Process Clarified** — The team agreed to use tagging for escalation, with the understanding that if someone is tagged on a weekend it's likely important.

## Next Steps
* **Review the local discovery PRs** (Alex)
`
    const { doc } = passFooterPresentation(parseNotes(source))
    const incident = doc.topical.find((section) => /incident|escalation/i.test(section.name))
    const analytics = doc.topical.find((section) => /analytics/i.test(section.name))
    const incidentLines = incident?.groups.flatMap((group) => [group.title, ...group.children]) ?? []
    const analyticsLines = analytics?.groups.flatMap((group) => [group.title, ...group.children]) ?? []
    expect(analyticsLines.some((line) => /^Agreed: collect login events/i.test(line))).toBe(true)
    expect(incidentLines.some((line) => /^Agreed:.*tagging for escalation/i.test(line))).toBe(true)
    expect(analyticsLines.some((line) => /tagging for escalation/i.test(line))).toBe(false)
  })

  it('sends a Reconsider title to Next Steps, not Agreed', () => {
    const source = `# Title

## Analytics
- Opt-in analytics copy is weak

## Decisions
* **Reconsider Opt-in Analytics Messaging** — Change the opt-in analytics dialogue to make it more compelling.

## Next Steps
* **Review the local discovery PRs** (Alex)
`
    expect(isClosedDecision(parseNotes(source).decisions[0]!)).toBe(false)
    const { doc } = passFooterPresentation(parseNotes(source))
    expect(doc.nextSteps.some((item) => /reconsider opt-in analytics messaging/i.test(item.title))).toBe(true)
    const topical = doc.topical.flatMap((section) =>
      section.groups.flatMap((group) => [group.title, ...group.children])
    )
    expect(topical.some((line) => /^Agreed:/i.test(line))).toBe(false)
  })

  it('sends an unfinished Decision to Next Steps, not the body', () => {
    const source = `# Title

## Soak
- Orion soak ships Thursday

## Decisions
* **Ship the Orion soak** — The team will ship the Orion soak on Thursday.

## Next Steps
* **Review the local discovery PRs** (Alex)
`
    const { doc } = passFooterPresentation(parseNotes(source))
    expect(doc.nextSteps.some((item) => item.title === 'Ship the Orion soak')).toBe(true)
    const topical = doc.topical.flatMap((section) =>
      section.groups.flatMap((group) => [group.title, ...group.children])
    )
    expect(topical.some((line) => /^Agreed:.*orion soak/i.test(line))).toBe(false)
    expect(renderNotes(doc)).not.toMatch(/## Decisions/)
  })

  it('drops a rationale when facts already appear in the title', () => {
    const source = `# Title

## Analytics
- Mix Panel GUID collisions happen in QA

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Investigate Mix Panel 500 GUID limit** (Alex) — Alex observed the 500 GUID limit in QA.
`
    const { doc } = passFooterPresentation(parseNotes(source))
    const item = doc.nextSteps.find((row) => /500 GUID/i.test(row.title))
    expect(item?.body).toBe('')
    expect(item?.owners).toEqual(['Alex'])
    expect(renderActionBullet(item!)).toBe('* **Investigate Mix Panel 500 GUID limit** (Alex)')
  })

  it('preserves a leftover deadline or number as a parenthetical', () => {
    const source = `# Title

## Billing
- The billing library must be updated

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Update the billing library** (Alex) — Due end of August and costs $1/seat.
`
    const item = parseNotes(source).nextSteps[0]!
    expect(leftoverFooterFacts(item, 'Billing\nThe billing library must be updated')).toEqual(
      expect.arrayContaining(['end of August', '$1/seat'])
    )
    const { doc } = passFooterPresentation(parseNotes(source))
    const compacted = doc.nextSteps.find((row) => /billing library/i.test(row.title))
    expect(compacted?.owners).toEqual(expect.arrayContaining(['Alex', 'end of August', '$1/seat']))
    expect(compacted?.body).toBe('')
    expect(renderActionBullet(compacted!)).toMatch(/\(Alex, end of August, \$1\/seat\)/)
  })

  it('drops a leftover verb from the parenthetical', () => {
    const source = `# Title

## Relay
- Relay services are under review

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Research alternative relay services** (Alex) — Check the dashboard and improve latency.
`
    const item = parseNotes(source).nextSteps[0]!
    const leftover = leftoverFooterFacts(item, 'Relay\nRelay services are under review')
    expect(leftover.join(' ')).not.toMatch(/check|latency|identify|sending|rate/i)
    const { doc } = passFooterPresentation(parseNotes(source))
    const compacted = doc.nextSteps.find((row) => /relay services/i.test(row.title))
    expect(renderActionBullet(compacted!)).toBe('* **Research alternative relay services** (Alex)')
  })

  it('keeps a leftover number that appears only in the dropped rationale', () => {
    const source = `# Title

## Analytics
- Mix Panel GUID collisions happen in QA

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Investigate Mix Panel GUID limit issues** (Alex) — QA hit the 500 GUID limit on iPad.
`
    const leftover = leftoverFooterFacts(
      parseNotes(source).nextSteps[0]!,
      'Analytics\nMix Panel GUID collisions happen in QA'
    )
    expect(leftover).toEqual(expect.arrayContaining(['500', 'iPad']))
    const { doc } = passFooterPresentation(parseNotes(source))
    expect(renderActionBullet(doc.nextSteps[0]!)).toBe(
      '* **Investigate Mix Panel GUID limit issues** (Alex, 500, iPad)'
    )
  })

  it('does not append a leftover generic noun as a body bullet', () => {
    const source = `# Title

## Relay
- Relay services are under review

## Decisions
* **Keep the soak** — Ship Thursday.

## Next Steps
* **Research alternative relay services** (Alex) — improve latency and service reliability.
`
    const { doc } = passFooterPresentation(parseNotes(source))
    const topical = doc.topical.flatMap((section) =>
      section.groups.flatMap((group) => [group.title, ...group.children])
    )
    expect(topical.some((line) => /^latency$/i.test(line.trim()))).toBe(false)
    expect(renderNotes(doc)).not.toMatch(/^- latency$/m)
    expect(renderActionBullet(doc.nextSteps[0]!)).toBe('* **Research alternative relay services** (Alex)')
  })

  it('omits an empty Decisions heading after classify', () => {
    const source = `# Title

## Soak
- Orion soak ships Thursday

## Decisions
* **Ship the Orion soak** — The team will ship the Orion soak on Thursday.

## Next Steps
* **Review the local discovery PRs** (Alex)
`
    const { doc } = passFooterPresentation(parseNotes(source))
    expect(doc.decisions).toHaveLength(0)
    expect(renderNotes(doc)).not.toMatch(/## Decisions/)
    expect(renderNotes(doc)).toMatch(/## Next Steps/)
  })

  it('never leaves a Next Steps for… title in Decisions', () => {
    const source = `# Title

## Relay
- Relay pool monitoring is updated

## Decisions
* **Next Steps for Relay Pool Monitoring System Update** — Them will do another product release after this meeting.

## Next Steps
* **Review the local discovery PRs** (Alex)
`
    const { doc } = passFooterPresentation(parseNotes(source))
    expect(doc.decisions.some((item) => /^next steps for/i.test(item.title))).toBe(false)
    expect(doc.nextSteps.some((item) => /^next steps for/i.test(item.title))).toBe(true)
  })
})
