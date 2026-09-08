import { expect, it } from 'vitest'
import { clusterNoteEmbeddings } from '../windows-notes-clustering'

it('separates semantic neighborhoods without topic labels or a requested group count', () => {
  const vectors = [
    [1, 0.02, 0],
    [1, 0, 0.02],
    [1, 0.01, 0.01],
    [0.02, 1, 0],
    [0, 1, 0.02],
    [0.01, 1, 0.01],
    [0.02, 0, 1],
    [0, 0.02, 1],
    [0.01, 0.01, 1]
  ]
  expect(clusterNoteEmbeddings(vectors)).toEqual([
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8]
  ])
})
it('preserves all records once when vectors are indistinguishable', () => {
  const groups = clusterNoteEmbeddings(Array.from({ length: 10 }, () => [1, 0]))
  expect(groups.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i))
})
it('can reunite recurring subjects despite intervening unrelated records', () => {
  const vectors = Array.from({ length: 9 }, (_, index) => [
    index % 3 === 0 ? 1 : 0,
    index % 3 === 1 ? 1 : 0,
    index % 3 === 2 ? 1 : 0
  ])
  expect(clusterNoteEmbeddings(vectors)).toEqual([
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8]
  ])
})
it.each(
  [
    [
      [0, 0],
      [1, 0],
      [0, 1]
    ],
    [[1], [1, 2], [2]],
    [[NaN], [1], [2]]
  ].map((vectors) => ({ vectors }))
)('rejects unusable vectors', ({ vectors }) => {
  expect(() => clusterNoteEmbeddings(vectors)).toThrow()
})
