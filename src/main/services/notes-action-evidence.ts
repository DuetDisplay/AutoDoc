import type { Transcript } from '../../shared/types'

export interface ActionEvidenceTurn {
  text: string
  rows: Transcript[]
}

/** Include adjacent long ASR rows using their end times, not start-time gaps. */
export function actionEvidenceNeighborhood(
  rows: readonly Transcript[],
  startMs: number,
  endMs: number
): Transcript[] {
  let first = rows.findIndex((row) => row.startMs >= startMs && row.startMs <= endMs)
  if (first < 0) return []
  let last = first
  while (last + 1 < rows.length && rows[last + 1].startMs <= endMs) last += 1
  for (let count = 0; count < 2 && first > 0; count += 1) {
    if (rows[first].startMs - rows[first - 1].endMs > 12_000) break
    first -= 1
  }
  for (let count = 0; count < 2 && last + 1 < rows.length; count += 1) {
    if (rows[last + 1].startMs - rows[last].endMs > 12_000) break
    last += 1
  }
  return rows.slice(first, last + 1)
}

function comparable(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Reconstruct continuous speech for action matching; never edit the transcript. */
export function actionEvidenceTurns(rows: readonly Transcript[]): ActionEvidenceTurn[] {
  const texts = rows.map((row) => comparable(row.text))
  const kept = rows.filter((row, index) => {
    if (/^(?:okay|ok|yeah|yes|yep|thanks|thank you|all right|mm hmm)[.!?\s]*$/iu.test(row.text))
      return false
    return !rows.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.meetingId === row.meetingId &&
        other.speaker === row.speaker &&
        other.startMs <= row.startMs &&
        other.endMs >= row.endMs &&
        texts[otherIndex].length > texts[index].length &&
        ` ${texts[otherIndex]} `.includes(` ${texts[index]} `)
    )
  })
  const turns: ActionEvidenceTurn[] = []
  for (const row of kept) {
    const previous = turns.at(-1)
    const last = previous?.rows.at(-1)
    if (
      previous &&
      last &&
      last.speaker === row.speaker &&
      last.meetingId === row.meetingId &&
      row.startMs >= last.startMs &&
      Math.abs(row.startMs - last.endMs) <= 1000 &&
      !/[.!?]["'’”]?\s*$/u.test(previous.text) &&
      /^[a-z]/u.test(row.text)
    ) {
      previous.text += ` ${row.text}`
      previous.rows.push(row)
    } else {
      turns.push({ text: row.text, rows: [row] })
    }
  }
  return turns
}
