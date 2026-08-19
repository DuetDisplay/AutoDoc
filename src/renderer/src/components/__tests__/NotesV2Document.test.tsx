import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MeetingNotesV2 } from '../../../../shared/types'
import { NotesV2Document } from '../NotesV2Document'

function notes(): MeetingNotesV2 {
  return {
    schemaVersion: 2,
    meetingId: 'm1',
    sourceTranscriptRevision: 'transcript-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceAttributionRevision:
      'notes-attribution-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    revision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    overview: { text: 'The team aligned on analytics coverage.', sources: [{ startMs: 0, endMs: 10 }], provenance: 'generated' },
    keyTakeaways: [
      {
        id: 't1',
        title: 'Collect login events',
        topic: null,
        owner: null,
        deadline: null,
        text: 'Collect login events',
        sources: [{ startMs: 0, endMs: 10 }],
        provenance: 'generated'
      }
    ],
    sections: [
      {
        id: 's1',
        title: 'Analytics',
        summary: null,
        keyPoints: [
          {
            id: 'p1',
            title: 'Consent to Analytics',
            topic: 'Analytics',
            owner: null,
            deadline: null,
            text: 'A fix is needed on the Consent to Analytics event.',
            sources: [{ startMs: 1200, endMs: 1800 }],
            provenance: 'generated'
          }
        ],
        supportingDetails: [
          {
            id: 'd1',
            title: null,
            topic: 'Analytics',
            owner: null,
            deadline: null,
            text: 'Agreed: collect login events from all users',
            sources: [{ startMs: 2000, endMs: 2600 }],
            provenance: 'generated'
          }
        ]
      }
    ],
    decisions: [],
    nextSteps: [
      {
        id: 'n1',
        title: 'Review the offline analytics PR',
        topic: null,
        owner: 'Norbert',
        deadline: null,
        text: 'Review the offline analytics PR',
        sources: [{ startMs: 4000, endMs: 4500 }],
        provenance: 'generated',
        completed: false
      }
    ]
  }
}

describe('NotesV2Document', () => {
  it('lets the user switch Option 1 / Option 2 and persist a next-step check', async () => {
    const onToggle = vi.fn()
    render(
      <NotesV2Document
        notes={notes()}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onToggleNextStep={onToggle}
      />
    )

    expect(screen.getByRole('button', { name: 'Option 1' })).toBeInTheDocument()
    expect(screen.getByText('Review the offline analytics PR')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Option 2' }))
    expect(screen.getByText('The team aligned on analytics coverage.')).toBeInTheDocument()
    expect(screen.getByText('Collect login events')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenCalledWith('n1', true)
  })

  it('edits, deletes, and adds through writeV2 without regenerating', async () => {
    const onWrite = vi.fn()
    render(
      <NotesV2Document
        notes={notes()}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onToggleNextStep={vi.fn()}
        onWrite={onWrite}
      />
    )

    await userEvent.click(screen.getByText('A fix is needed on the Consent to Analytics event.'))
    const editor = screen.getByRole('textbox')
    await userEvent.clear(editor)
    await userEvent.type(editor, 'Ship the analytics fix this week')
    await userEvent.tab()

    expect(onWrite).toHaveBeenCalled()
    const edited = onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>
    expect(edited.sections[0].keyPoints[0].text).toBe('Ship the analytics fix this week')
    expect(edited.sections[0].keyPoints[0].provenance).toBe('user-edited')

    onWrite.mockClear()
    await userEvent.click(screen.getByTestId('delete-p1'))
    const afterDelete = onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>
    expect(afterDelete.sections[0].keyPoints).toHaveLength(0)

    onWrite.mockClear()
    await userEvent.click(screen.getByRole('button', { name: '+ Add topic' }))
    const afterAdd = onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>
    expect(afterAdd.sections).toHaveLength(2)
    expect(afterAdd.sections[1].keyPoints[0].provenance).toBe('user-created')
  })
})
