/** Ask AI retrieval: reserve the top semantic match; set AUTODOC_ASK_AI_TOP_MATCH=0 to disable. */
export function useAskAiTopMatch(): boolean {
  return process.env.AUTODOC_ASK_AI_TOP_MATCH !== '0'
}

export function normalizeDuplicateEvidence(text: string): string {
  return text
    .replace(/^Overview\s*·\s*/iu, '')
    .replace(/^(?:me|them|speaker\s*\d+)\s*:\s*/iu, '')
    .trim()
}

interface MatchPassage {
  key: string
  meetingId: string
  text: string
}

export function reserveAskAiTopMatch<T extends MatchPassage>(
  picked: T[],
  candidate: T | undefined,
  options: {
    named: boolean
    eligible: ReadonlySet<string>
    carried: ReadonlySet<string>
    counts: Map<string, number>
  }
): void {
  const { named, eligible, carried, counts } = options
  if (named || !candidate || !eligible.has(candidate.meetingId)) return
  const represented = picked.some(
    (p) =>
      p.key === candidate.key ||
      normalizeDuplicateEvidence(p.text) === normalizeDuplicateEvidence(candidate.text)
  )
  if (represented) return
  const atCap = (counts.get(candidate.meetingId) ?? 0) >= (carried.has(candidate.meetingId) ? 2 : 3)
  for (let i = picked.length - 1; i >= 0; i--) {
    const old = picked[i]
    if (carried.has(old.meetingId)) continue
    if (atCap && old.meetingId !== candidate.meetingId) continue
    picked[i] = candidate
    counts.set(old.meetingId, (counts.get(old.meetingId) ?? 0) - 1)
    counts.set(candidate.meetingId, (counts.get(candidate.meetingId) ?? 0) + 1)
    return
  }
}
