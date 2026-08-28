import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingNotesV2 } from '../../../../shared/types'
import { NotesV2Document } from '../NotesV2Document'

const isWindowsRenderer = vi.hoisted(() => vi.fn(() => false))

vi.mock('../../services/microphone-access', () => ({
  isWindowsRenderer
}))

function notes(): MeetingNotesV2 {
  return {
    schemaVersion: 2,
    meetingId: 'm1',
    sourceTranscriptRevision:
      'transcript-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceAttributionRevision:
      'notes-attribution-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    revision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    overview: {
      text: 'The team aligned on analytics coverage.',
      sources: [{ startMs: 0, endMs: 10 }],
      provenance: 'generated'
    },
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
    isWindowsRenderer.mockReturnValue(false)
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
    expect(screen.getByRole('heading', { name: 'Key Takeaways' })).toBeInTheDocument()
    expect(screen.getByText('Collect login events')).toBeInTheDocument()
    expect(screen.getByText('Review the offline analytics PR')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/open/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Option 2' }))
    expect(screen.getByText('The team aligned on analytics coverage.')).toBeInTheDocument()
    expect(screen.getByText('Collect login events')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/open/i)).not.toBeInTheDocument()
  })

  it('shows a distinct next-step title, complete body, and deadline without duplication', async () => {
    const sample = notes()
    sample.nextSteps = [
      {
        ...sample.nextSteps[0],
        title: 'Follow up on QA',
        text: 'Ask Sergio for a smoke-test estimate as soon as the build arrives.',
        deadline: 'When the build arrives'
      },
      { ...sample.nextSteps[0], id: 'n2' }
    ]

    render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
      />
    )

    expect(
      screen.getByText('Ask Sergio for a smoke-test estimate as soon as the build arrives.')
    ).toBeInTheDocument()
    expect(screen.getByText('Follow up on QA')).toBeInTheDocument()
    expect(screen.getByText('Due: When the build arrives')).toBeInTheDocument()

    expect(screen.getAllByText('Review the offline analytics PR')).toHaveLength(1)
  })

  it('edits a distinct Mac next-step body without retaining its stale generated title', async () => {
    const onWrite = vi.fn()
    const sample = notes()
    sample.nextSteps = [
      {
        ...sample.nextSteps[0],
        title: 'Follow up on QA',
        text: 'Ask Sergio for a smoke-test estimate as soon as the build arrives.',
        deadline: 'When the build arrives'
      }
    ]

    render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onWrite={onWrite}
      />
    )

    await userEvent.click(
      screen.getByText('Ask Sergio for a smoke-test estimate as soon as the build arrives.')
    )
    const editor = screen.getByRole('textbox')
    await userEvent.clear(editor)
    await userEvent.type(editor, 'Ask Sergio for the QA estimate when the build arrives')
    await userEvent.tab()

    const edited = onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>
    expect(edited.nextSteps[0]).toMatchObject({
      title: null,
      text: 'Ask Sergio for the QA estimate when the build arrives',
      deadline: 'When the build arrives',
      owner: 'Norbert',
      provenance: 'user-edited'
    })
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
    expect(edited.sections[0].keyPoints[0].title).toBeNull()
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

  it('renders decisions in both layouts and jumps to their source', async () => {
    const onSeek = vi.fn()
    const sample = notes()
    sample.decisions = [
      {
        id: 'decision-1',
        title: 'Release the free tier at a 50/50 split',
        topic: null,
        owner: null,
        deadline: null,
        text: 'Release the free tier at a 50/50 split after smoke testing passes.',
        sources: [{ startMs: 5200, endMs: 5900 }],
        provenance: 'generated'
      }
    ]

    render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={onSeek}
      />
    )

    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeInTheDocument()
    expect(screen.getByText('Release the free tier at a 50/50 split')).toBeInTheDocument()
    expect(
      screen.getByText('Release the free tier at a 50/50 split after smoke testing passes.')
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '0:05' }))
    expect(onSeek).toHaveBeenLastCalledWith(5200)

    await userEvent.click(screen.getByRole('button', { name: 'Option 2' }))
    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '▶ 0:05' }))
    expect(onSeek).toHaveBeenLastCalledWith(5200)
  })

  it('uses grounded decisions and actions for the summary when there are no topic sections', () => {
    const sample = notes()
    sample.overview = null
    sample.sections = []
    sample.decisions = [
      {
        id: 'decision-only',
        title: 'Wait for QA',
        topic: null,
        owner: null,
        deadline: null,
        text: 'The release will wait until the smoke test passes.',
        sources: [{ startMs: 1000, endMs: 2000 }],
        provenance: 'generated'
      }
    ]

    render(
      <NotesV2Document
        notes={sample}
        title="Release review"
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
      />
    )

    expect(
      screen.getByText('The release will wait until the smoke test passes.')
    ).toBeInTheDocument()
    expect(
      screen.getByText((_text, element) => {
        return (
          element?.tagName === 'P' &&
          element.textContent?.startsWith('The release will wait until the smoke test passes.') ===
            true
        )
      })
    ).toBeInTheDocument()
    expect(screen.queryByText('Notes from Release review.')).not.toBeInTheDocument()
  })

  it('edits and deletes decisions through writeV2 without affecting other content', async () => {
    const onWrite = vi.fn()
    const sample = notes()
    sample.decisions = [
      {
        id: 'decision-1',
        title: 'Release at 50/50',
        topic: null,
        owner: null,
        deadline: null,
        text: 'Release at 50/50 after smoke testing passes.',
        sources: [{ startMs: 5200, endMs: 5900 }],
        provenance: 'generated'
      }
    ]

    render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onWrite={onWrite}
      />
    )

    await userEvent.click(screen.getByText('Release at 50/50 after smoke testing passes.'))
    const editor = screen.getByRole('textbox')
    await userEvent.clear(editor)
    await userEvent.type(editor, 'Release at 50/50 once QA clears')
    await userEvent.tab()

    const edited = onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>
    expect(edited.decisions[0].text).toBe('Release at 50/50 once QA clears')
    expect(edited.decisions[0].title).toBeNull()
    expect(edited.decisions[0].provenance).toBe('user-edited')
    expect(edited.sections).toEqual(sample.sections)
    expect(edited.nextSteps).toEqual(sample.nextSteps)

    onWrite.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Delete decision' }))
    const afterDelete = onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>
    expect(afterDelete.decisions).toEqual([])
    expect(afterDelete.sections).toEqual(sample.sections)
    expect(afterDelete.nextSteps).toEqual(sample.nextSteps)
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

  it('nests extra Windows key points when the scan left supporting details empty', () => {
    isWindowsRenderer.mockReturnValue(true)
    const sample = notes()
    sample.sections[0].keyPoints = [
      sample.sections[0].keyPoints[0],
      {
        ...sample.sections[0].keyPoints[0],
        id: 'p2',
        text: 'Users have not encountered instability'
      }
    ]
    sample.sections[0].supportingDetails = []
    render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
      />
    )

    expect(screen.getByTestId('sub-p2')).toHaveTextContent('Users have not encountered instability')
  })

  it('keeps the existing Windows presentation while macOS lossless notes are proven', () => {
    isWindowsRenderer.mockReturnValue(true)
    const sample = notes()
    sample.overview = null
    sample.decisions = [
      {
        id: 'decision-1',
        title: 'Release at 50/50',
        topic: null,
        owner: null,
        deadline: null,
        text: 'Release at 50/50 after smoke testing passes.',
        sources: [{ startMs: 5200, endMs: 5900 }],
        provenance: 'generated'
      }
    ]
    sample.nextSteps = [
      {
        ...sample.nextSteps[0],
        title: 'Follow up on QA',
        text: 'Ask Sergio for a smoke-test estimate as soon as the build arrives.',
        deadline: 'When the build arrives'
      }
    ]

    render(
      <NotesV2Document
        notes={sample}
        title="Release review"
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
      />
    )

    expect(screen.queryByRole('heading', { name: 'Decisions' })).not.toBeInTheDocument()
    expect(
      screen.queryByText('Release at 50/50 after smoke testing passes.')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Follow up on QA')).toBeInTheDocument()
    expect(
      screen.queryByText('Ask Sergio for a smoke-test estimate as soon as the build arrives.')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Due: When the build arrives')).not.toBeInTheDocument()
  })

  it('edits the displayed Windows next-step title without replacing its detailed body', async () => {
    isWindowsRenderer.mockReturnValue(true)
    const onWrite = vi.fn()
    const sample = notes()
    sample.nextSteps = [
      {
        ...sample.nextSteps[0],
        title: 'Follow up on QA',
        text: 'Ask Sergio for a smoke-test estimate as soon as the build arrives.',
        deadline: 'When the build arrives'
      }
    ]

    render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onWrite={onWrite}
      />
    )

    await userEvent.click(screen.getByText('Follow up on QA'))
    const editor = screen.getByRole('textbox')
    await userEvent.clear(editor)
    await userEvent.type(editor, 'Check the QA estimate')
    await userEvent.tab()

    const edited = onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>
    expect(edited.nextSteps[0]).toMatchObject({
      title: 'Check the QA estimate',
      text: 'Ask Sergio for a smoke-test estimate as soon as the build arrives.',
      deadline: 'When the build arrives',
      owner: 'Norbert',
      provenance: 'user-edited'
    })
  })

  it('keeps extra Mac key points as peers when supporting details are empty', () => {
    const sample = notes()
    sample.sections[0].keyPoints = [
      sample.sections[0].keyPoints[0],
      {
        ...sample.sections[0].keyPoints[0],
        id: 'p2',
        text: 'Users have not encountered instability'
      }
    ]
    sample.sections[0].supportingDetails = []
    render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
      />
    )

    expect(screen.queryByTestId('sub-p2')).not.toBeInTheDocument()
    expect(screen.getByText('Users have not encountered instability')).toBeInTheDocument()
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
    expect(
      (onWrite.mock.calls.at(-1)?.[0] as ReturnType<typeof notes>).nextSteps[0].owner
    ).toBeNull()
  })
})
