import type { NoteItem, NoteSection } from './types'

export function displayNoteSectionHierarchy<TItem extends NoteItem>(
  section: Pick<NoteSection, 'keyPoints' | 'supportingDetails'> & {
    keyPoints: TItem[]
    supportingDetails: TItem[]
  },
  nestFlatPeers: boolean
): { keyPoints: TItem[]; supportingDetails: TItem[] } {
  if (
    nestFlatPeers &&
    section.supportingDetails.length === 0 &&
    section.keyPoints.length > 1
  ) {
    return {
      keyPoints: [section.keyPoints[0]],
      supportingDetails: section.keyPoints.slice(1)
    }
  }

  return {
    keyPoints: section.keyPoints,
    supportingDetails: section.supportingDetails
  }
}

export function nestFlatPeerKeyPoints<TSection extends NoteSection>(
  sections: readonly TSection[]
): TSection[] {
  return sections.map((section) => {
    const hierarchy = displayNoteSectionHierarchy(section, true)
    if (hierarchy.supportingDetails === section.supportingDetails) return section
    return { ...section, ...hierarchy }
  })
}
