import { isDeepStrictEqual } from 'node:util'
import type { MeetingSegments, Segment } from '../../shared/types'

const BUCKETS: readonly (keyof MeetingSegments)[] = [
  'decisions', 'actionItems', 'information', 'discussion', 'statusUpdates'
]

/**
 * Remove only fully identical records after generation has finished. Do not
 * change the writer's inter-chunk context, merge similar claims, or conceal
 * conflicting IDs from the lossless presenter's validation.
 */
export function removeExactDuplicateSegments<T extends MeetingSegments>(segments: T): T {
  const result = { ...segments }
  let changed = false
  for (const bucket of BUCKETS) {
    const seen = new Map<string, Segment[]>()
    const kept = segments[bucket].filter((segment) => {
      const sameId = seen.get(segment.id)
      if (sameId?.some((previous) => isDeepStrictEqual(previous, segment))) return false
      if (sameId) sameId.push(segment)
      else seen.set(segment.id, [segment])
      return true
    })
    if (kept.length !== segments[bucket].length) {
      result[bucket] = kept
      changed = true
    }
  }
  return changed ? result : segments
}
