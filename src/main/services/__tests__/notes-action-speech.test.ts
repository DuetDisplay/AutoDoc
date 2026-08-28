import { describe, expect, it } from 'vitest'
import {
  actionPredicatesConflict,
  actionPredicatesOverlap,
  actionSpeechActSupportsSummary
} from '../notes-action-speech'

describe('notes action speech', () => {
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
  ])('supports an explicit %s commitment with object evidence', (verb, object) => {
    expect(actionSpeechActSupportsSummary(`I'll ${verb} ${object}.`, `${verb} ${object}.`)).toBe(
      true
    )
  })

  it.each([
    ['emailing', 'Email the launch brief.'],
    ['scheduling', 'Schedule the QA review.'],
    ['deploying', 'Deploy the signed build.'],
    ['monitoring', 'Monitor the error rate.'],
    ['writing', 'Write the release notes.'],
    ['removing', 'Remove the stale flag.'],
    ['calling', 'Call the vendor.'],
    ['notifying', 'Notify the beta users.'],
    ['documenting', 'Document the rollout process.']
  ])('matches the in-progress inflection %s to its action family', (verb, summary) => {
    expect(
      actionSpeechActSupportsSummary(
        `I'm ${verb} ${summary.slice(summary.indexOf(' ') + 1)}`,
        summary
      )
    ).toBe(true)
  })

  it('supports an unknown clear action verb only inside an explicit speech act', () => {
    expect(
      actionSpeechActSupportsSummary(
        "I'll archive the incident report.",
        'Archive the incident report.'
      )
    ).toBe(true)
    expect(
      actionSpeechActSupportsSummary(
        'Morgan, please archive the incident report.',
        'Archive the incident report.'
      )
    ).toBe(true)
    expect(actionPredicatesOverlap('Archive the incident report', 'Archived incident report')).toBe(
      true
    )
    expect(actionPredicatesOverlap('Archive the release notes', 'Email the release notes')).toBe(
      false
    )
  })

  it('grounds each commitment inside a long punctuation-poor transcript row', () => {
    const evidence =
      "I'm planning to refine the notes layout and then I'll send the reviewers an internal build and then I'll publish the launch brief."

    expect(actionSpeechActSupportsSummary(evidence, 'Send the reviewers an internal build.')).toBe(
      true
    )
    expect(actionSpeechActSupportsSummary(evidence, 'Publish the launch brief.')).toBe(true)
  })

  it('recognizes a concrete generic commitment against its verbatim wording', () => {
    const commitment = "I'll get the reviewers an internal build to use in their meetings."
    expect(actionSpeechActSupportsSummary(commitment, commitment)).toBe(true)
  })

  it('detects only known incompatible action families', () => {
    expect(actionPredicatesConflict('Send the report.', "I'll review the report.")).toBe(true)
    expect(actionPredicatesConflict('Prepare the build.', "I'll get the team a build.")).toBe(false)
  })

  it.each([
    ["I'll archive it.", 'Archive the incident report.'],
    ["I'll do that.", 'Do the incident report.'],
    ["I'll be ready.", 'Prepare the incident report.'],
    ['Archive the incident report.', 'Archive the incident report.']
  ])('rejects generic verbs without an explicit supported object: %s', (evidence, summary) => {
    expect(actionSpeechActSupportsSummary(evidence, summary)).toBe(false)
  })
})
