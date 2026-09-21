import { describe, expect, it } from 'vitest'
import type { TranscriptRevision } from '../../../shared/types'
import type {
  NotesEvidenceClaim,
  NotesInferenceClient,
  NotesMappedClaim,
  NotesReduceResult,
  NotesRuntimeProfile
} from '../notes-inference-client'
import { computeNotesAttributionRevision } from '../notes-revision'
import {
  createNotesTranscriptAnchors,
  mergeExactEvidenceClaims,
  runNotesV2Pipeline,
  type NotesTranscriptRow
} from '../notes-v2-pipeline'
import { NotesPipelineError } from '../notes-v2-validation'

const meetingId = 'meeting-v2'
const transcriptRevision =
  'transcript-sha256:1111111111111111111111111111111111111111111111111111111111111111' as TranscriptRevision

const profile: NotesRuntimeProfile = {
  model: 'test-model',
  contextWindowTokens: 4096,
  maxOutputTokens: 1024,
  acceleration: 'cpu',
  memoryPressure: 'normal',
  allowedConcurrency: 1
}

const rows: NotesTranscriptRow[] = [
  {
    id: 'row-zero',
    meetingId,
    speaker: 'me',
    confirmedSpeakerLabel: 'Chris',
    text: 'The migration status is green.',
    startMs: 0,
    endMs: 0,
    confidence: 1
  },
  {
    id: 'row-one',
    meetingId,
    speaker: 'them',
    text: 'The migration status is green.',
    startMs: 10,
    endMs: 20,
    confidence: 1
  },
  {
    id: 'row-two',
    meetingId,
    speaker: 'them',
    text: 'The migration status is green.',
    startMs: 21,
    endMs: 30,
    confidence: 1
  }
]

function emptyReduced(): NotesReduceResult {
  return { overview: null, keyTakeaways: [], sections: [], decisions: [], nextSteps: [] }
}

function response<T>(value: T, complete = true) {
  return { complete, value, usage: { inputTokens: 10, outputTokens: 5 } }
}

function claim(sourceId: string, overrides: Partial<NotesMappedClaim> = {}): NotesMappedClaim {
  return {
    text: 'Migration status is green.',
    sourceIds: [sourceId as `source:${string}`],
    modality: 'status',
    topic: null,
    salience: 'normal',
    exactReferences: [],
    protectedSignals: [],
    owner: null,
    deadline: null,
    ...overrides
  }
}

function validClient(overrides: Partial<NotesInferenceClient> = {}): NotesInferenceClient {
  return {
    async map({ chunk }) {
      return response(chunk.anchors.map((anchor) => claim(anchor.sourceId)))
    },
    async reconcile({ evidence }) {
      return response({
        groups: evidence.map((claim) => ({
          evidenceIds: [claim.id],
          primaryEvidenceId: claim.id
        }))
      })
    },
    async reduce({ evidence }) {
      return response({
        ...emptyReduced(),
        keyTakeaways: [
          {
            title: null,
            topic: 'Migration',
            owner: null,
            deadline: null,
            text: 'Migration status is green.',
            evidenceIds: [evidence[0].id]
          }
        ]
      })
    },
    ...overrides
  }
}

describe('Notes V2 pure inference pipeline', () => {
  it('uses deterministic row-bound anchors, sequential map chunks, and retains a three-range union', async () => {
    const requestedChunks: number[][] = []
    let reconcileAttributions: NotesEvidenceClaim['sourceAttributions'] = []
    let reduceAttributions: NotesEvidenceClaim['sourceAttributions'] = []
    const client = validClient({
      async map({ chunk }) {
        requestedChunks.push(chunk.anchors.map((anchor) => anchor.startMs))
        return response(chunk.anchors.map((anchor) => claim(anchor.sourceId)))
      },
      async reconcile({ evidence }) {
        reconcileAttributions = evidence[0].sourceAttributions
        return response({
          groups: evidence.map((entry) => ({
            evidenceIds: [entry.id],
            primaryEvidenceId: entry.id
          }))
        })
      },
      async reduce({ evidence }) {
        reduceAttributions = evidence[0].sourceAttributions
        return response({
          ...emptyReduced(),
          keyTakeaways: [
            {
              title: null,
              topic: 'Migration',
              owner: null,
              deadline: null,
              text: 'Migration status is green.',
              evidenceIds: [evidence[0].id]
            }
          ]
        })
      }
    })

    const result = await runNotesV2Pipeline(client, {
      meetingId,
      transcriptRows: rows,
      profile,
      maxAnchorsPerChunk: 2
    })

    expect(requestedChunks).toEqual([[0, 10], [21]])
    expect(result.metrics.mapMaxConcurrency).toBe(1)
    expect(result.content.keyTakeaways[0].sources).toEqual([
      { startMs: 0, endMs: 0 },
      { startMs: 10, endMs: 20 },
      { startMs: 21, endMs: 30 }
    ])
    expect(result.metrics.mapClaims).toBe(1)
    expect(reconcileAttributions).toHaveLength(3)
    expect(reduceAttributions).toEqual(reconcileAttributions)
    expect(reconcileAttributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ speakerId: 'me', confirmedSpeakerLabel: 'Chris' }),
        expect.objectContaining({ speakerId: 'them', confirmedSpeakerLabel: null })
      ])
    )

    const again = await runNotesV2Pipeline(client, {
      meetingId,
      transcriptRows: [...rows].reverse(),
      profile,
      maxAnchorsPerChunk: 1
    })
    expect(again.content).toEqual(result.content)
    expect(again.sourceTranscriptRevision).toBe(result.sourceTranscriptRevision)

    const relabeled = await runNotesV2Pipeline(client, {
      meetingId,
      transcriptRows: rows.map((row) => ({ ...row, confirmedSpeakerLabel: 'Taylor' })),
      profile,
      maxAnchorsPerChunk: 3
    })
    expect(relabeled.sourceTranscriptRevision).toBe(result.sourceTranscriptRevision)
    expect(relabeled.sourceAttributionRevision).not.toBe(result.sourceAttributionRevision)
    expect(computeNotesAttributionRevision(meetingId, rows)).toBe(result.sourceAttributionRevision)
  })

  it('keeps generated item and section IDs stable across evidence order and unrelated siblings', async () => {
    const identityRows: NotesTranscriptRow[] = [
      {
        ...rows[0],
        id: 'row-alpha',
        text: 'Alpha migration status is green.',
        startMs: 0,
        endMs: 5
      },
      {
        ...rows[1],
        id: 'row-beta',
        text: 'Beta migration status is green.',
        startMs: 10,
        endMs: 15
      },
      {
        ...rows[2],
        id: 'row-gamma',
        text: 'Gamma migration status is green.',
        startMs: 20,
        endMs: 25
      }
    ]
    const client = (withEarlierSiblings: boolean): NotesInferenceClient =>
      validClient({
        async map({ chunk }) {
          return response(
            chunk.anchors.map((anchor) => claim(anchor.sourceId, { text: anchor.text }))
          )
        },
        async reduce({ evidence }) {
          const alpha = evidence.find((entry) => entry.text.startsWith('Alpha'))!
          const beta = evidence.find((entry) => entry.text.startsWith('Beta'))!
          const gamma = evidence.find((entry) => entry.text.startsWith('Gamma'))!
          const targetEvidenceIds = withEarlierSiblings ? [beta.id, alpha.id] : [alpha.id, beta.id]
          const targetItem = {
            title: null,
            topic: 'Migration',
            owner: null,
            deadline: null,
            text: 'Migration status is green.',
            evidenceIds: targetEvidenceIds
          }
          const unrelatedItem = {
            ...targetItem,
            topic: 'Gamma',
            text: 'Gamma migration status is green.',
            evidenceIds: [gamma.id]
          }
          const targetSection = {
            title: 'Migration',
            summary: {
              text: 'Migration status is green.',
              evidenceIds: targetEvidenceIds
            },
            keyPoints: [],
            supportingDetails: []
          }
          const unrelatedSection = {
            ...targetSection,
            title: 'Gamma',
            summary: {
              text: 'Gamma migration status is green.',
              evidenceIds: [gamma.id]
            }
          }
          return response({
            ...emptyReduced(),
            keyTakeaways: withEarlierSiblings
              ? [unrelatedItem, targetItem, targetItem]
              : [targetItem],
            sections: withEarlierSiblings
              ? [unrelatedSection, targetSection, targetSection]
              : [targetSection]
          })
        }
      })

    const baseline = await runNotesV2Pipeline(client(false), {
      meetingId,
      transcriptRows: identityRows,
      profile
    })
    const reordered = await runNotesV2Pipeline(client(true), {
      meetingId,
      transcriptRows: identityRows,
      profile
    })
    const targetItems = reordered.content.keyTakeaways.filter((item) => item.topic === 'Migration')
    const targetSections = reordered.content.sections.filter(
      (section) => section.title === 'Migration'
    )

    expect(targetItems[0].id).toBe(baseline.content.keyTakeaways[0].id)
    expect(targetSections[0].id).toBe(baseline.content.sections[0].id)
    expect(new Set(targetItems.map((item) => item.id)).size).toBe(2)
    expect(new Set(targetSections.map((section) => section.id)).size).toBe(2)
  })

  it('does not merge distinct facts merely because they share source ranges', () => {
    const [firstAnchor] = createNotesTranscriptAnchors(meetingId, transcriptRevision, rows)
    const shared = [firstAnchor.sourceId]
    const claims: NotesEvidenceClaim[] = [
      {
        id: 'evidence:first',
        text: 'The migration is green.',
        sourceIds: shared,
        modality: 'status',
        topic: null,
        salience: 'normal',
        exactReferences: [],
        protectedSignals: [],
        sourceAttributions: [
          {
            sourceId: firstAnchor.sourceId,
            speakerId: firstAnchor.speakerId,
            confirmedSpeakerLabel: firstAnchor.confirmedSpeakerLabel
          }
        ],
        owner: null,
        deadline: null
      },
      {
        id: 'evidence:second',
        text: 'The deployment is Friday.',
        sourceIds: shared,
        modality: 'fact',
        topic: null,
        salience: 'normal',
        exactReferences: [],
        protectedSignals: [],
        sourceAttributions: [
          {
            sourceId: firstAnchor.sourceId,
            speakerId: firstAnchor.speakerId,
            confirmedSpeakerLabel: firstAnchor.confirmedSpeakerLabel
          }
        ],
        owner: null,
        deadline: null
      }
    ]

    expect(mergeExactEvidenceClaims(claims)).toHaveLength(2)
  })

  it('merges reordered exact references before assigning one canonical evidence ID', async () => {
    const literalRows = [{ ...rows[0], text: 'Ann confirmed exactly 42 tasks.' }]
    let reconciliationEvidenceIds: string[] = []
    const client = validClient({
      async map({ chunk }) {
        const sourceId = chunk.anchors[0].sourceId
        const references = [
          { kind: 'name' as const, value: 'Ann', evidenceSourceIds: [sourceId] },
          { kind: 'number' as const, value: '42', evidenceSourceIds: [sourceId] }
        ]
        return response([
          claim(sourceId, { text: 'Ann confirmed 42 tasks.', exactReferences: references }),
          claim(sourceId, {
            text: 'Ann confirmed 42 tasks.',
            exactReferences: [...references].reverse()
          })
        ])
      },
      async reconcile({ evidence }) {
        reconciliationEvidenceIds = evidence.map((claim) => claim.id)
        return response({
          groups: evidence.map((claim) => ({
            evidenceIds: [claim.id],
            primaryEvidenceId: claim.id
          }))
        })
      },
      async reduce({ evidence }) {
        return response({
          ...emptyReduced(),
          keyTakeaways: [
            {
              title: null,
              topic: null,
              owner: null,
              deadline: null,
              text: 'Ann confirmed 42 tasks.',
              evidenceIds: [evidence[0].id]
            }
          ]
        })
      }
    })
    const result = await runNotesV2Pipeline(client, {
      meetingId,
      transcriptRows: literalRows,
      profile
    })

    expect(result.metrics.mapClaims).toBe(1)
    expect(reconciliationEvidenceIds).toHaveLength(1)
    expect(new Set(reconciliationEvidenceIds).size).toBe(1)
  })

  it('canonicalizes owner and deadline evidence order before assigning evidence IDs', async () => {
    const candidateRows: NotesTranscriptRow[] = [
      {
        ...rows[0],
        id: 'row-candidate-one',
        text: 'Ann will ship Friday.',
        startMs: 0,
        endMs: 5
      },
      {
        ...rows[1],
        id: 'row-candidate-two',
        text: 'Ann will ship Friday.',
        startMs: 10,
        endMs: 15
      }
    ]

    const run = async (reverseCandidateSources: boolean): Promise<NotesEvidenceClaim> => {
      const observedEvidence: NotesEvidenceClaim[] = []
      const client = validClient({
        async map({ chunk }) {
          const sourceIds = chunk.anchors.map((anchor) => anchor.sourceId)
          const candidateSourceIds = reverseCandidateSources ? [...sourceIds].reverse() : sourceIds
          return response([
            claim(sourceIds[0], {
              text: 'Ann will ship Friday.',
              sourceIds,
              modality: 'commitment',
              owner: {
                value: 'Ann',
                evidenceSourceIds: candidateSourceIds,
                isExplicitAssignment: true
              },
              deadline: {
                value: 'Friday',
                evidenceSourceIds: candidateSourceIds,
                isExplicitDeadline: true
              }
            })
          ])
        },
        async reconcile({ evidence }) {
          observedEvidence.push(evidence[0])
          return response({
            groups: [{ evidenceIds: [evidence[0].id], primaryEvidenceId: evidence[0].id }]
          })
        },
        async reduce({ evidence }) {
          return response({
            ...emptyReduced(),
            overview: {
              text: 'Ann will ship Friday.',
              evidenceIds: [evidence[0].id]
            }
          })
        }
      })

      await runNotesV2Pipeline(client, {
        meetingId,
        transcriptRows: candidateRows,
        profile
      })
      return observedEvidence[0]
    }

    const forward = await run(false)
    const reversed = await run(true)
    const canonicalSourceIds = [...forward.sourceIds].sort()

    expect(reversed.id).toBe(forward.id)
    expect(forward.owner?.evidenceSourceIds).toEqual(canonicalSourceIds)
    expect(reversed.owner?.evidenceSourceIds).toEqual(canonicalSourceIds)
    expect(forward.deadline?.evidenceSourceIds).toEqual(canonicalSourceIds)
    expect(reversed.deadline?.evidenceSourceIds).toEqual(canonicalSourceIds)
  })

  it('grounds a name exact reference in the cited confirmed speaker label', async () => {
    let exactReferences: NotesEvidenceClaim['exactReferences'] = []
    const client = validClient({
      async map({ chunk }) {
        const sourceId = chunk.anchors[0].sourceId
        return response([
          claim(sourceId, {
            text: 'Chris confirmed the migration status is green.',
            exactReferences: [{ kind: 'name', value: 'Chris', evidenceSourceIds: [sourceId] }]
          })
        ])
      },
      async reconcile({ evidence }) {
        exactReferences = evidence[0].exactReferences
        return response({
          groups: [{ evidenceIds: [evidence[0].id], primaryEvidenceId: evidence[0].id }]
        })
      },
      async reduce({ evidence }) {
        return response({
          ...emptyReduced(),
          overview: {
            text: 'Chris confirmed the migration status is green.',
            evidenceIds: [evidence[0].id]
          }
        })
      }
    })

    await runNotesV2Pipeline(client, {
      meetingId,
      transcriptRows: [rows[0]],
      profile
    })

    expect(exactReferences).toEqual([expect.objectContaining({ kind: 'name', value: 'Chris' })])
  })

  it('code-detects grounded exact literals without double-counting nested numbers', async () => {
    const text =
      'Use https://example.com/releases/2026-08-06, budget $1,250.50, deadline August 6, 2026, and rollout 42%.'
    const literalRows = [{ ...rows[0], text }]
    let exactReferences: NotesEvidenceClaim['exactReferences'] = []
    let protectedSignals: NotesEvidenceClaim['protectedSignals'] = []
    const client = validClient({
      async map({ chunk }) {
        return response([claim(chunk.anchors[0].sourceId, { text })])
      },
      async reconcile({ evidence }) {
        exactReferences = evidence[0].exactReferences
        protectedSignals = evidence[0].protectedSignals
        return response({
          groups: [{ evidenceIds: [evidence[0].id], primaryEvidenceId: evidence[0].id }]
        })
      },
      async reduce({ evidence }) {
        return response({
          ...emptyReduced(),
          keyTakeaways: [
            {
              title: null,
              topic: null,
              owner: null,
              deadline: null,
              text,
              evidenceIds: [evidence[0].id]
            }
          ]
        })
      }
    })

    await runNotesV2Pipeline(client, { meetingId, transcriptRows: literalRows, profile })

    expect(exactReferences).toEqual([
      expect.objectContaining({ kind: 'amount', value: '$1,250.50' }),
      expect.objectContaining({ kind: 'date', value: 'August 6, 2026' }),
      expect.objectContaining({ kind: 'number', value: '42%' }),
      expect.objectContaining({
        kind: 'url',
        value: 'https://example.com/releases/2026-08-06'
      })
    ])
    expect(protectedSignals).toContain('deadline')
  })

  it('rejects unknown source IDs rather than resolving model-provided timestamps', async () => {
    await expect(
      runNotesV2Pipeline(
        validClient({
          async map() {
            return response([
              claim('source:not-in-this-meeting', { text: 'Invented source.', modality: 'fact' })
            ])
          }
        }),
        { meetingId, transcriptRows: rows, profile }
      )
    ).rejects.toMatchObject({ code: 'unknown-source-id' satisfies NotesPipelineError['code'] })
  })

  it('rejects model-authored source attribution', async () => {
    await expect(
      runNotesV2Pipeline(
        validClient({
          async map({ chunk }) {
            return response([
              {
                ...claim(chunk.anchors[0].sourceId),
                sourceAttributions: [
                  {
                    sourceId: chunk.anchors[0].sourceId,
                    speakerId: 'spoofed',
                    confirmedSpeakerLabel: 'Spoofed'
                  }
                ]
              } as unknown as NotesMappedClaim
            ])
          }
        }),
        { meetingId, transcriptRows: [rows[0]], profile }
      )
    ).rejects.toMatchObject({ code: 'invalid-model-output' satisfies NotesPipelineError['code'] })
  })

  it('rejects a real source ID cited from a different map chunk', async () => {
    let firstChunkSourceId: `source:${string}` | null = null
    const client = validClient({
      async map({ chunk }) {
        if (chunk.index === 0) {
          firstChunkSourceId = chunk.anchors[0].sourceId
          return response([claim(firstChunkSourceId)])
        }
        return response([claim(firstChunkSourceId!)])
      }
    })
    await expect(
      runNotesV2Pipeline(client, {
        meetingId,
        transcriptRows: rows,
        profile,
        maxAnchorsPerChunk: 1
      })
    ).rejects.toMatchObject({ code: 'unknown-source-id' satisfies NotesPipelineError['code'] })
  })

  it('rejects transcript rows from another meeting before inference', async () => {
    await expect(
      runNotesV2Pipeline(validClient(), {
        meetingId,
        transcriptRows: [{ ...rows[0], meetingId: 'other-meeting' }],
        profile
      })
    ).rejects.toMatchObject({ code: 'invalid-anchor' satisfies NotesPipelineError['code'] })
  })

  it('rejects proposal-as-decision promotion', async () => {
    const client = validClient({
      async map({ chunk }) {
        return response(
          chunk.anchors.map((anchor) =>
            claim(anchor.sourceId, { text: 'We could ship the migration.', modality: 'proposal' })
          )
        )
      },
      async reduce({ evidence }) {
        return response({
          ...emptyReduced(),
          decisions: [
            {
              title: null,
              topic: null,
              owner: null,
              deadline: null,
              text: 'Ship the migration.',
              evidenceIds: [evidence[0].id]
            }
          ]
        })
      }
    })

    await expect(
      runNotesV2Pipeline(client, { meetingId, transcriptRows: rows, profile })
    ).rejects.toMatchObject({
      code: 'invalid-modality-promotion' satisfies NotesPipelineError['code']
    })
  })

  it('rejects a nonqualifying next-step promotion', async () => {
    const client = validClient({
      async reduce({ evidence }) {
        return response({
          ...emptyReduced(),
          nextSteps: [
            {
              title: null,
              topic: null,
              owner: null,
              deadline: null,
              text: 'Follow up on the status.',
              evidenceIds: [evidence[0].id]
            }
          ]
        })
      }
    })
    await expect(
      runNotesV2Pipeline(client, { meetingId, transcriptRows: rows, profile })
    ).rejects.toMatchObject({
      code: 'invalid-modality-promotion' satisfies NotesPipelineError['code']
    })
  })

  it('rejects unsupported owners and deadlines', async () => {
    const ownerRows = [{ ...rows[0], text: 'We are planning the migration.' }]
    const unsupportedOwner = validClient({
      async map({ chunk }) {
        return response([
          claim(chunk.anchors[0].sourceId, {
            text: 'We are planning the migration.',
            modality: 'commitment',
            owner: {
              // `Ann` must not be accepted just because it is a substring of "planning".
              value: 'Ann',
              evidenceSourceIds: [chunk.anchors[0].sourceId],
              isExplicitAssignment: true
            }
          })
        ])
      }
    })
    await expect(
      runNotesV2Pipeline(unsupportedOwner, {
        meetingId,
        transcriptRows: ownerRows,
        profile
      })
    ).rejects.toMatchObject({ code: 'unsupported-owner' satisfies NotesPipelineError['code'] })

    const unsupportedDeadline = validClient({
      async map({ chunk }) {
        return response([
          claim(chunk.anchors[0].sourceId, {
            text: 'The migration will ship.',
            modality: 'commitment',
            deadline: {
              value: 'Friday',
              evidenceSourceIds: [chunk.anchors[0].sourceId],
              isExplicitDeadline: true
            }
          })
        ])
      }
    })
    await expect(
      runNotesV2Pipeline(unsupportedDeadline, {
        meetingId,
        transcriptRows: rows,
        profile
      })
    ).rejects.toMatchObject({ code: 'unsupported-deadline' satisfies NotesPipelineError['code'] })
  })

  it('rejects reducer output that omits selected exact details', async () => {
    const literalRows = [{ ...rows[0], text: 'The migration has exactly 42 tasks.' }]
    const client = validClient({
      async map({ chunk }) {
        return response([
          claim(chunk.anchors[0].sourceId, {
            text: 'The migration has 42 tasks.',
            exactReferences: [
              {
                kind: 'number',
                value: '42',
                evidenceSourceIds: [chunk.anchors[0].sourceId]
              }
            ]
          })
        ])
      },
      async reduce() {
        return response(emptyReduced())
      }
    })
    await expect(
      runNotesV2Pipeline(client, { meetingId, transcriptRows: literalRows, profile })
    ).rejects.toMatchObject({ code: 'missing-evidence' satisfies NotesPipelineError['code'] })
  })

  it('rejects reducer output that omits protected evidence', async () => {
    const protectedRows = [{ ...rows[0], text: 'The security review is required.' }]
    const client = validClient({
      async map({ chunk }) {
        return response([
          claim(chunk.anchors[0].sourceId, {
            text: 'A security review is required.',
            protectedSignals: ['security']
          })
        ])
      },
      async reduce() {
        return response(emptyReduced())
      }
    })
    await expect(
      runNotesV2Pipeline(client, { meetingId, transcriptRows: protectedRows, profile })
    ).rejects.toMatchObject({ code: 'missing-evidence' satisfies NotesPipelineError['code'] })
  })

  it('requires every code-detected protected anchor to be cited by a mapped claim', async () => {
    const protectedRows = [
      rows[0],
      { ...rows[1], text: 'A security incident requires immediate review.' }
    ]
    const client = validClient({
      async map({ chunk }) {
        return response([claim(chunk.anchors[0].sourceId)])
      }
    })

    await expect(
      runNotesV2Pipeline(client, { meetingId, transcriptRows: protectedRows, profile })
    ).rejects.toMatchObject({ code: 'missing-evidence' satisfies NotesPipelineError['code'] })
  })

  it('code-enriches a cited protected claim so the reducer must retain it', async () => {
    const text = 'A service outage requires immediate review.'
    const protectedRows = [{ ...rows[0], text }]
    let protectedSignals: NotesEvidenceClaim['protectedSignals'] = []
    const client = validClient({
      async map({ chunk }) {
        return response([claim(chunk.anchors[0].sourceId, { text })])
      },
      async reconcile({ evidence }) {
        protectedSignals = evidence[0].protectedSignals
        return response({
          groups: [{ evidenceIds: [evidence[0].id], primaryEvidenceId: evidence[0].id }]
        })
      },
      async reduce({ evidence }) {
        return response({
          ...emptyReduced(),
          overview: { text, evidenceIds: [evidence[0].id] }
        })
      }
    })

    await runNotesV2Pipeline(client, { meetingId, transcriptRows: protectedRows, profile })

    expect(protectedSignals).toContain('outage')
  })

  it('rejects a cited block that alters an exact literal', async () => {
    const literalRows = [{ ...rows[0], text: 'The migration has exactly 42 tasks.' }]
    const client = validClient({
      async map({ chunk }) {
        return response([
          claim(chunk.anchors[0].sourceId, {
            text: 'The migration has 42 tasks.',
            exactReferences: [
              {
                kind: 'number',
                value: '42',
                evidenceSourceIds: [chunk.anchors[0].sourceId]
              }
            ]
          })
        ])
      },
      async reduce({ evidence }) {
        return response({
          ...emptyReduced(),
          keyTakeaways: [
            {
              title: null,
              topic: null,
              owner: null,
              deadline: null,
              text: 'The migration has 43 tasks.',
              evidenceIds: [evidence[0].id]
            }
          ]
        })
      }
    })
    await expect(
      runNotesV2Pipeline(client, { meetingId, transcriptRows: literalRows, profile })
    ).rejects.toMatchObject({ code: 'invalid-evidence' satisfies NotesPipelineError['code'] })
  })

  it('rejects a reducer-invented literal even when the mapper declared no exact references', async () => {
    const client = validClient({
      async reduce({ evidence }) {
        return response({
          ...emptyReduced(),
          keyTakeaways: [
            {
              title: null,
              topic: null,
              owner: null,
              deadline: null,
              text: 'The migration has 43 tasks.',
              evidenceIds: [evidence[0].id]
            }
          ]
        })
      }
    })

    await expect(
      runNotesV2Pipeline(client, { meetingId, transcriptRows: rows, profile })
    ).rejects.toMatchObject({ code: 'invalid-evidence' satisfies NotesPipelineError['code'] })
  })

  it('rejects whitespace section headings and empty sections', async () => {
    const whitespaceHeading = validClient({
      async reduce({ evidence }) {
        return response({
          ...emptyReduced(),
          sections: [
            {
              title: '   ',
              summary: {
                text: 'Migration status is green.',
                evidenceIds: [evidence[0].id]
              },
              keyPoints: [],
              supportingDetails: []
            }
          ]
        })
      }
    })
    await expect(
      runNotesV2Pipeline(whitespaceHeading, { meetingId, transcriptRows: rows, profile })
    ).rejects.toMatchObject({ code: 'invalid-model-output' satisfies NotesPipelineError['code'] })

    const emptySection = validClient({
      async reduce() {
        return response({
          ...emptyReduced(),
          sections: [
            {
              title: 'Migration',
              summary: null,
              keyPoints: [],
              supportingDetails: []
            }
          ]
        })
      }
    })
    await expect(
      runNotesV2Pipeline(emptySection, { meetingId, transcriptRows: rows, profile })
    ).rejects.toMatchObject({ code: 'invalid-model-output' satisfies NotesPipelineError['code'] })
  })

  it('retries an incomplete response once and fails after its bounded retry budget', async () => {
    let attempts = 0
    const client = validClient({
      async map({ chunk }) {
        attempts += 1
        if (attempts === 1) return response([], false)
        return response([claim(chunk.anchors[0].sourceId)])
      }
    })
    const result = await runNotesV2Pipeline(client, {
      meetingId,
      transcriptRows: [rows[0]],
      profile
    })
    expect(result.metrics.stages[0]).toMatchObject({ calls: 2, retries: 1 })

    await expect(
      runNotesV2Pipeline(
        validClient({
          async map() {
            return response([], false)
          }
        }),
        {
          meetingId,
          transcriptRows: [rows[0]],
          profile,
          maxAttempts: 2
        }
      )
    ).rejects.toMatchObject({ code: 'truncated-response' satisfies NotesPipelineError['code'] })
  })
})
