import type { IndexedMeeting } from '../meeting-index'
export function leverWriterCases() {
  const excerpts = [
    {
      meetingId: 'atlas',
      title: 'Atlas launch review',
      date: 0,
      kind: 'note' as const,
      text: 'The approved budget is $47,250. Mira owns the migration.'
    }
  ]
  return [
    {
      question: 'Who owns Atlas?',
      excerpts,
      language: 'en' as const,
      conversation: { history: [], inventoryCount: 20, replyLanguage: 'en' },
      tools: true
    },
    {
      question: 'And the Atlas budget? Reply in Japanese.',
      excerpts,
      language: 'ja' as const,
      conversation: {
        history: [
          { role: 'user' as const, content: 'Who owns Atlas?' },
          { role: 'assistant' as const, content: 'Mira owns it. [1]' }
        ],
        inventoryCount: 20,
        replyLanguage: 'ja'
      },
      tools: true
    },
    {
      question: 'Et son budget ?',
      excerpts,
      language: 'fr' as const,
      conversation: { history: [{ role: 'user' as const, content: 'Atlas' }], inventoryCount: 20 },
      tools: false
    },
    { question: 'What is the Atlas budget?', excerpts, language: 'en' as const, tools: false }
  ]
}
export function leverMeetings(): IndexedMeeting[] {
  return Array.from({ length: 16 }, (_, i) => ({
    meetingId: `m${i}`,
    title: `Atlas project ${i}`,
    date: i,
    dir: '/unused',
    sourceName: 'Synthetic',
    signature: 'fixed',
    noteEntries: [
      {
        id: `n${i}`,
        title: 'Atlas project budget',
        topic: 'Atlas project',
        content: `The Atlas project approved budget is ${1000 + i} dollars.`,
        category: 'information',
        owner: null,
        deadline: null,
        sources: []
      }
    ],
    transcriptChunks: []
  })) as IndexedMeeting[]
}
