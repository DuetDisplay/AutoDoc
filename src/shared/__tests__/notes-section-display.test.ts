import { describe, expect, it } from 'vitest'
import { displayNoteSectionHierarchy, nestFlatPeerKeyPoints } from '../notes-section-display'
import type { NoteItem, NoteSection } from '../types'

function item(id: string, text: string): NoteItem {
  return {
    id,
    title: text,
    topic: 'Topic',
    owner: null,
    deadline: null,
    text,
    sources: [{ startMs: 0, endMs: 10 }],
    provenance: 'generated',
    completed: false
  }
}

function section(keyPoints: NoteItem[], supportingDetails: NoteItem[]): NoteSection {
  return {
    id: 's1',
    title: 'Topic',
    summary: null,
    keyPoints,
    supportingDetails
  }
}

describe('displayNoteSectionHierarchy', () => {
  it('leaves Mac-shaped sections with supporting details unchanged', () => {
    const current = section([item('p1', 'Parent')], [item('d1', 'Child')])
    expect(displayNoteSectionHierarchy(current, true)).toEqual({
      keyPoints: current.keyPoints,
      supportingDetails: current.supportingDetails
    })
    expect(displayNoteSectionHierarchy(current, false)).toEqual({
      keyPoints: current.keyPoints,
      supportingDetails: current.supportingDetails
    })
  })

  it('nests extra key points only when asked and there are no supporting details', () => {
    const current = section([item('p1', 'Parent'), item('p2', 'Child A'), item('p3', 'Child B')], [])
    expect(displayNoteSectionHierarchy(current, false)).toEqual({
      keyPoints: current.keyPoints,
      supportingDetails: []
    })
    expect(displayNoteSectionHierarchy(current, true)).toEqual({
      keyPoints: [current.keyPoints[0]],
      supportingDetails: [current.keyPoints[1], current.keyPoints[2]]
    })
  })
})

describe('nestFlatPeerKeyPoints', () => {
  it('does not rewrite a section that already has supporting details', () => {
    const current = section([item('p1', 'Parent'), item('p2', 'Peer')], [item('d1', 'Child')])
    expect(nestFlatPeerKeyPoints([current])).toEqual([current])
  })
})
