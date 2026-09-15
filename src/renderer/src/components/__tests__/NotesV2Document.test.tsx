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
        id: 'lossless-takeaway:t1',
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
        id: 'lossless-section:topical:s1',
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

/** Notes saved before the lossless presenter carry no lossless IDs. */
function legacyNotes(): MeetingNotesV2 {
  const sample = notes()
  sample.keyTakeaways = sample.keyTakeaways.map((item, index) => ({
    ...item,
    id: `t${index + 1}`
  }))
  sample.sections = sample.sections.map((section, index) => ({
    ...section,
    id: `s${index + 1}`
  }))
  return sample
}

describe('NotesV2Document', () => {
  beforeEach(() => {
    isWindowsRenderer.mockReturnValue(false)
  })

  it('renders the timestamp-column notes layout without a layout toggle or next-step checkboxes', () => {
    render(
      <NotesV2Document
        notes={notes()}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: 'Option 1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Option 2' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument()
    expect(screen.getByText('The team aligned on analytics coverage.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Key Takeaways' })).toBeInTheDocument()
    expect(screen.getByText('Collect login events')).toBeInTheDocument()
    expect(screen.queryByText('Review the offline analytics PR')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/open/i)).not.toBeInTheDocument()
  })

  it('puts the meeting title at the top and labels the overview Summary', () => {
    const { container } = render(
      <NotesV2Document
        notes={notes()}
        title="duet-display - Slack"
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
      />
    )

    expect(screen.queryByText('Recorded meeting')).not.toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: 'duet-display - Slack' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument()
    const title = container.querySelector('h2')
    const summary = container.querySelector('#notes-summary')
    expect(title?.textContent).toBe('duet-display - Slack')
    expect(summary).not.toBeNull()
    expect(title?.compareDocumentPosition(summary!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('hides next steps on Mac and Windows even when items exist', () => {
    const sample = notes()
    sample.nextSteps = [
      {
        ...sample.nextSteps[0],
        title: 'Follow up on QA',
        text: 'Ask Sergio for a smoke-test estimate as soon as the build arrives.',
        deadline: 'When the build arrives'
      }
    ]

    const view = render(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onWrite={vi.fn()}
      />
    )

    expect(screen.queryByRole('heading', { name: 'Next Steps' })).not.toBeInTheDocument()
    expect(screen.queryByText('Follow up on QA')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Ask Sergio for a smoke-test estimate as soon as the build arrives.')
    ).not.toBeInTheDocument()

    isWindowsRenderer.mockReturnValue(true)
    view.rerender(
      <NotesV2Document
        notes={sample}
        meetingSpan={[{ startMs: 0, endMs: 10_000 }]}
        onSeek={vi.fn()}
        onWrite={vi.fn()}
      />
    )
    expect(screen.queryByRole('heading', { name: 'Next Steps' })).not.toBeInTheDocument()
    expect(screen.queryByText('Follow up on QA')).not.toBeInTheDocument()
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

  it('renders bold markdown, nested supporting lines, and timestamp jumps', async () => {
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

    await userEvent.click(screen.getByRole('button', { name: '▶ 0:01' }))
    expect(onSeek).toHaveBeenCalledWith(1200)
  })

  it('renders decisions and jumps to their source', async () => {
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

    await userEvent.click(screen.getByRole('button', { name: '▶ 0:05' }))
    expect(onSeek).toHaveBeenLastCalledWith(5200)
  })

  it('keeps untitled notes visible without inventing a heading', () => {
    const sample = notes()
    sample.decisions = []
    sample.sections = [
      {
        id: 'lossless-section:topical:untitled',
        title: '',
        summary: null,
        keyPoints: [
          {
            id: 'open-1',
            title: 'Stripe improved',
            topic: null,
            owner: null,
            deadline: null,
            text: 'Stripe was higher week over week.',
            sources: [{ startMs: 3500, endMs: 3600 }],
            provenance: 'generated'
          }
        ],
        supportingDetails: []
      }
    ]

    render(
      <NotesV2Document notes={sample} meetingSpan={[{ startMs: 0, endMs: 10_000 }]} onSeek={vi.fn()} />
    )

    expect(screen.getByText('Stripe was higher week over week.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Information' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Decisions' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument()
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
      screen.getAllByText('The release will wait until the smoke test passes.').length
    ).toBeGreaterThan(0)
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
    const sample = legacyNotes()
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

  it('keeps the existing Windows presentation for notes without lossless IDs', () => {
    isWindowsRenderer.mockReturnValue(true)
    const sample = legacyNotes()
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
    expect(screen.queryByRole('heading', { name: 'Next Steps' })).not.toBeInTheDocument()
    expect(screen.queryByText('Follow up on QA')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Ask Sergio for a smoke-test estimate as soon as the build arrives.')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Due: When the build arrives')).not.toBeInTheDocument()
  })

  it('renders the full lossless hierarchy on Windows when the notes carry lossless IDs', async () => {
    isWindowsRenderer.mockReturnValue(true)
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

    expect(screen.getByText('The team aligned on analytics coverage.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Key Takeaways' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeInTheDocument()
    expect(screen.getByText('Release at 50/50 after smoke testing passes.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Next Steps' })).not.toBeInTheDocument()
    expect(
      screen.queryByText('Ask Sergio for a smoke-test estimate as soon as the build arrives.')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Due: When the build arrives')).not.toBeInTheDocument()
  })

  it('keeps extra Windows key points as peers when the notes carry lossless IDs', () => {
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

    expect(screen.queryByTestId('sub-p2')).not.toBeInTheDocument()
    expect(screen.getByText('Users have not encountered instability')).toBeInTheDocument()
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

  it('does not repeat the section topic on bullets or takeaways', () => {
    isWindowsRenderer.mockReturnValue(true)
    const sample = notes()
    sample.overview = {
      ...sample.overview!,
      text: [
        'Cancellations — The data indicates 14 starts and 6 cancellations.',
        'Minimum RAM requirement updated for Autodoc — Raised Windows minimum RAM to 16 GB.',
        'Granola format limitations — Local models struggle with formatting.',
        'App icon does not update in dark mode — The icon stays stale until restart.'
      ].join('\n')
    }
    sample.keyTakeaways = [
      {
        id: 'lossless-takeaway:cancels',
        title: 'Cancellations',
        topic: 'Cancellations',
        owner: null,
        deadline: null,
        text: 'The data indicates 14 starts and 6 cancellations.',
        sources: [{ startMs: 1000, endMs: 2000 }],
        provenance: 'generated'
      }
    ]
    sample.sections.unshift({
      id: 'lossless-section:topical:other',
      title: 'Other Notes',
      summary: null,
      keyPoints: [
        {
          id: 'other-1',
          title: 'Cable redesign',
          topic: 'Other Notes',
          owner: null,
          deadline: null,
          text: 'The cable connection element was redesigned.',
          sources: [{ startMs: 3000, endMs: 4000 }],
          provenance: 'generated'
        }
      ],
      supportingDetails: []
    })

    render(
      <NotesV2Document notes={sample} meetingSpan={[{ startMs: 0, endMs: 10_000 }]} onSeek={vi.fn()} />
    )

    expect(screen.getByText(
      'The data indicates 14 starts and 6 cancellations. Raised Windows minimum RAM to 16 GB.'
    )).toBeInTheDocument()
    expect(screen.queryByText(/Cancellations —/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Granola format limitations/)).not.toBeInTheDocument()
    expect(screen.getAllByText('Analytics')).toHaveLength(1)
    expect(screen.queryByText('Cancellations')).not.toBeInTheDocument()
    expect(
      screen.getByText('The data indicates 14 starts and 6 cancellations.')
    ).toBeInTheDocument()
    expect(screen.getAllByText('Other Notes')).toHaveLength(1)
    expect(screen.getByText('The cable connection element was redesigned.')).toBeInTheDocument()
    const analytics = screen.getByRole('heading', { name: 'Analytics' })
    const otherNotes = screen.getByRole('heading', { name: 'Other Notes' })
    expect(analytics.compareDocumentPosition(otherNotes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Next Steps' })).not.toBeInTheDocument()
  })

  it('hides Needs Review leftovers from the customer document', () => {
    isWindowsRenderer.mockReturnValue(true)
    const sample = notes()
    sample.decisions = [
      {
        id: 'junk-decision',
        title: 'Um Get the nines',
        topic: 'Needs Review',
        owner: null,
        deadline: null,
        text: 'Um Get the nines repositioned.',
        sources: [{ startMs: 1000, endMs: 2000 }],
        provenance: 'generated'
      }
    ]
    sample.nextSteps = [
      ...sample.nextSteps,
      {
        id: 'junk-step',
        title: 'Share Politic',
        topic: 'Needs Review',
        owner: 'Me',
        deadline: null,
        text: 'Share Politic.',
        sources: [{ startMs: 3000, endMs: 4000 }],
        provenance: 'generated',
        completed: false
      }
    ]
    sample.sections.push({
      id: 'lossless-section:topical:review',
      title: 'Needs Review',
      summary: null,
      keyPoints: [
        {
          id: 'junk-body',
          title: 'But logs show it was running',
          topic: 'Needs Review',
          owner: null,
          deadline: null,
          text: 'But logs show it was running',
          sources: [{ startMs: 5000, endMs: 6000 }],
          provenance: 'generated'
        }
      ],
      supportingDetails: []
    })

    render(
      <NotesV2Document notes={sample} meetingSpan={[{ startMs: 0, endMs: 10_000 }]} onSeek={vi.fn()} />
    )

    expect(screen.queryByRole('heading', { name: 'Needs Review' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Decisions' })).not.toBeInTheDocument()
    expect(screen.queryByText('Share Politic.')).not.toBeInTheDocument()
    expect(screen.queryByText('But logs show it was running')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Next Steps' })).not.toBeInTheDocument()
    expect(screen.queryByText('Review the offline analytics PR')).not.toBeInTheDocument()
  })
})
