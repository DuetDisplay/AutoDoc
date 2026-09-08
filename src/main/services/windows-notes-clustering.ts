/** Local modularity optimization over a sparse cosine-neighbor graph.
 * No topic names, transcript words, timestamps or requested topic count.
 * Inputs are chronological. A source-order prior distinguishes similar
 * vocabulary used in different discussions without prohibiting topic returns.
 */
export function clusterNoteEmbeddings(vectors: readonly number[][]): number[][] {
  const count = vectors.length
  if (count < 3) return vectors.map((_, index) => [index])
  const dimension = vectors[0]?.length ?? 0
  if (
    !dimension ||
    vectors.some((row) => row.length !== dimension || row.some((value) => !Number.isFinite(value)))
  )
    throw new Error('Invalid note embeddings')
  const normalized = vectors.map((row) => {
    const norm = Math.sqrt(row.reduce((sum, value) => sum + value * value, 0))
    if (!norm) throw new Error('Empty note embedding')
    return row.map((value) => value / norm)
  })
  const similarity = normalized.map((left) =>
    normalized.map((right) =>
      Math.max(
        0,
        left.reduce((sum, value, index) => sum + value * right[index]!, 0)
      )
    )
  )
  let graph = vectors.map(() => Array<number>(count).fill(0))
  for (let row = 0; row < count; row++) {
    const neighbors = similarity[row]!.map((weight, index) => ({
      index,
      weight: weight / (1 + Math.abs(row - index) / 8)
    }))
      .filter((other) => other.index !== row && other.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.index - b.index)
      .slice(0, 4)
    for (const { index, weight } of neighbors) graph[row]![index] = graph[index]![row] = weight
  }
  let members = vectors.map((_, index) => [index])
  while (graph.length > 1) {
    const size = graph.length
    const degree = graph.map((row) => row.reduce((sum, weight) => sum + weight, 0))
    const total = degree.reduce((sum, value) => sum + value, 0)
    if (!total) break
    const community = graph.map((_, index) => index)
    const totals = [...degree]
    for (let pass = 0; pass < 30; pass++) {
      let moved = false
      for (let row = 0; row < size; row++) {
        const old = community[row]!
        const weights = new Map<number, number>()
        graph[row]!.forEach((weight, other) => {
          if (other !== row && weight > 0)
            weights.set(community[other]!, (weights.get(community[other]!) ?? 0) + weight)
        })
        totals[old]! -= degree[row]!
        let best = old
        let gain = (weights.get(old) ?? 0) - (degree[row]! * totals[old]!) / total
        for (const [candidate, weight] of weights) {
          const candidateGain = weight - (degree[row]! * totals[candidate]!) / total
          if (candidateGain > gain + 1e-10) {
            best = candidate
            gain = candidateGain
          }
        }
        community[row] = best
        totals[best]! += degree[row]!
        moved ||= best !== old
      }
      if (!moved) break
    }
    const labels = [...new Set(community)]
    if (labels.length === size) break
    const indexByLabel = new Map(labels.map((label, index) => [label, index]))
    const next = labels.map(() => Array<number>(labels.length).fill(0))
    const nextMembers = labels.map(() => [] as number[])
    for (let row = 0; row < size; row++) {
      const target = indexByLabel.get(community[row]!)!
      nextMembers[target]!.push(...members[row]!)
      for (let other = 0; other < size; other++)
        next[target]![indexByLabel.get(community[other]!)!]! += graph[row]![other]!
    }
    graph = next
    members = nextMembers
  }
  return members.map((group) => group.sort((a, b) => a - b)).sort((a, b) => a[0]! - b[0]!)
}
