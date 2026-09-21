import { describe, expect, it } from 'vitest'
import type { MeetingSegments, Segment } from '../../../shared/types'
import {
  isWriterCatalog,
  meetingSegmentsFromDisk,
  withoutNextStepCandidates,
  writerCatalogFromSegments
} from '../writer-catalog'

function segment(id: string, title: string): Segment {
  return {
    id,
    meetingId: 'm1',
    category: 'information',
    topic: 'Planning',
    title,
    content: `${title} content`,
    assignee: null,
    deadline: null,
    sourceStartMs: 0,
    sourceEndMs: 1000
  }
}

describe('writer-catalog', () => {
  it('writes items and next steps instead of five buckets', () => {
    const segments: MeetingSegments = {
      decisions: [segment('d1', 'Ship Friday')],
      actionItems: [
        {
          ...segment('a1', 'Write the rollback plan'),
          category: 'action_item',
          assignee: 'Chris'
        }
      ],
      information: [segment('i1', 'Rollback needs a flag')],
      discussion: [segment('disc1', 'Flag vs hotfix')],
      statusUpdates: [segment('s1', 'QA is still open')]
    }

    const catalog = writerCatalogFromSegments(segments)

    expect(catalog).toEqual({
      items: [segments.information[0], segments.decisions[0], segments.discussion[0], segments.statusUpdates[0]],
      nextSteps: [segments.actionItems[0]]
    })
    expect(catalog).not.toHaveProperty('decisions')
    expect(catalog).not.toHaveProperty('information')
    expect(isWriterCatalog(catalog)).toBe(true)
  })

  it('reads the catalog file back without five buckets', () => {
    const catalog = {
      items: [segment('i1', 'Rollback needs a flag')],
      nextSteps: [segment('a1', 'Write the rollback plan')]
    }

    expect(meetingSegmentsFromDisk(catalog)).toEqual({
      decisions: [],
      actionItems: catalog.nextSteps,
      information: catalog.items,
      discussion: [],
      statusUpdates: []
    })
  })

  it('still reads leftover five-bucket files', () => {
    const legacy: MeetingSegments = {
      decisions: [segment('d1', 'Ship Friday')],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }

    expect(meetingSegmentsFromDisk(legacy)).toEqual(legacy)
  })

  it('keeps rejected writer drafts out of persisted canonical notes and legacy search input', () => {
    const canonical: MeetingSegments = {
      decisions: [], actionItems: [], information: [segment('accepted', 'Accepted fact')],
      discussion: [], statusUpdates: []
    }
    const withDrafts = { ...canonical, nextStepCandidates: [segment('draft', 'Unsupported draft')] }
    expect(JSON.parse(JSON.stringify(withoutNextStepCandidates(withDrafts)))).toEqual(canonical)
    expect(meetingSegmentsFromDisk(JSON.parse(JSON.stringify(withDrafts)))).toEqual(canonical)
    expect(withDrafts.nextStepCandidates).toHaveLength(1)
  })
})
