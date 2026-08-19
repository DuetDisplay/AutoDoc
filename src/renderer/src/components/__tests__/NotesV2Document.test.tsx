import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
          },
          {
            id: 'd2',
            title: null,
            topic: 'Analytics',
            owner: null,
            deadline: null,
            text: 'HP opt-in for gaming PCs is 80-95%.',
            sources: [{ startMs: 2800, endMs: 3200 }],
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
  beforeEach(() => {
    window.localStorage.removeItem('autodoc.notesV2Option')
  })

  it('lets the user switch Option 1 / Option 2 without next-step checkboxes', async () => {
    render(
      <NotesV2Document
        notes={notes()}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Option 1' })).toBeInTheDocument()
    expect(screen.getByText('The team aligned on analytics coverage.')).toBeInTheDocument()
    expect(screen.getByText('Review the offline analytics PR')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/open/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Option 2' }))
    expect(screen.getByText('The team aligned on analytics coverage.')).toBeInTheDocument()
    expect(screen.queryByText('Collect login events')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/open/i)).not.toBeInTheDocument()
  })

  it('edits, deletes, and adds through writeV2 without regenerating', async () => {
    const onWrite = vi.fn()
    render(
      <NotesV2Document
        notes={notes()}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
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

  it('renders bold markdown, nested supporting lines, and Option 1 timestamp jumps', async () => {
    const onSeek = vi.fn()
    const sample = notes()
    sample.sections[0].keyPoints[0].text =
      '**Investigate accent keys** — Determine whether KMS is the cause.'
    render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={onSeek}
        onWrite={vi.fn()}
      />
    )

    expect(screen.getByText('Investigate accent keys')).toBeInTheDocument()
    expect(screen.queryByText(/\*\*Investigate accent keys\*\*/)).not.toBeInTheDocument()
    expect(screen.getByText('collect login events from all users')).toBeInTheDocument()
    expect(screen.getByText('HP opt-in for gaming PCs is 80-95%.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Option 1' }))
    await userEvent.click(screen.getByRole('button', { name: '0:01' }))
    expect(onSeek).toHaveBeenCalledWith(1200)
  })

  it('nests a supporting line under its parent instead of treating it as a peer', () => {
    const sample = notes()
    sample.sections[0].supportingDetails = [sample.sections[0].supportingDetails[0]]
    render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onWrite={vi.fn()}
      />
    )

    expect(screen.getByTestId('sub-d1')).toHaveTextContent('collect login events from all users')
    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument()
  })

  it('lets the user add, change, and clear a next-step owner', async () => {
    const onWrite = vi.fn()
    const sample = notes()
    sample.nextSteps[0].owner = null
    const view = render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onWrite={onWrite}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Add owner' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Owner' }), 'Raul')
    await userEvent.tab()

    const added = onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>
    expect(added.nextSteps[0].owner).toBe('Raul')
    expect(added.nextSteps[0].provenance).toBe('user-edited')

    onWrite.mockClear()
    view.rerender(
      <NotesV2Document
        notes={{ ...sample, nextSteps: [{ ...sample.nextSteps[0], owner: 'Raul' }] }}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onWrite={onWrite}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Owner: Raul' }))
    const editor = screen.getByRole('textbox', { name: 'Owner' })
    await userEvent.clear(editor)
    await userEvent.type(editor, 'Chris')
    await userEvent.tab()
    expect((onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>).nextSteps[0].owner).toBe(
      'Chris'
    )

    onWrite.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Remove owner' }))
    expect((onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>).nextSteps[0].owner).toBeNull()
  })
})
