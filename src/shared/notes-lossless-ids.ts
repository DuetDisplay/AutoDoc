/**
 * The lossless presenter stamps stable ID prefixes on the takeaways and
 * sections it emits. The renderer uses those IDs as the capability signal for
 * the lossless hierarchy, so saved notes keep the presentation their data was
 * generated for regardless of the current platform or app version.
 */
const LOSSLESS_TAKEAWAY_ID_PREFIX = 'lossless-takeaway:'
const LOSSLESS_SECTION_ID_PREFIX = 'lossless-section:'

export function notesUseLosslessPresentation(notes: {
  keyTakeaways: ReadonlyArray<{ id: string }>
  sections: ReadonlyArray<{ id: string }>
}): boolean {
  return (
    notes.keyTakeaways.some((item) => item.id.startsWith(LOSSLESS_TAKEAWAY_ID_PREFIX)) ||
    notes.sections.some((section) => section.id.startsWith(LOSSLESS_SECTION_ID_PREFIX))
  )
}
