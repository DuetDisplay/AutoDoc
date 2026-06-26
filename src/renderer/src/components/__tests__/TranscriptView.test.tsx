import { render, screen } from '@testing-library/react'
import { beforeEach, describe, it, expect } from 'vitest'
import { TranscriptView } from '../TranscriptView'
import type { Transcript } from '../../../../shared/types'
import { createElectronApiMock } from '../../test/fixtures'

const sampleTranscripts: Transcript[] = [
  {
    id: 'seg-0',
    meetingId: 'm1',
    speaker: 'Speaker',
    text: 'Hello everyone',
    startMs: 0,
    endMs: 3000,
    confidence: -1
  },
  {
    id: 'seg-1',
    meetingId: 'm1',
    speaker: 'Speaker',
    text: 'Let us begin the meeting',
    startMs: 3000,
    endMs: 7500,
    confidence: -1
  }
]

beforeEach(() => {
  window.electronAPI = createElectronApiMock({
    'whisper:get-setup-status': { phase: 'ready', percent: 100 }
  }) as any
})

describe('TranscriptView', () => {
  it('renders transcript segments with timestamps, merging consecutive same-speaker', () => {
    render(<TranscriptView segments={sampleTranscripts} status="complete" />)
    // Same speaker segments are merged into one block
    expect(screen.getByText('Hello everyone Let us begin the meeting')).toBeInTheDocument()
    expect(screen.getByText('0:00')).toBeInTheDocument()
  })

  it('does not over-merge long same-speaker runs into a massive paragraph', () => {
    const segments: Transcript[] = [
      {
        id: 'seg-0',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'First sentence with enough content to matter.',
        startMs: 0,
        endMs: 3000,
        confidence: -1
      },
      {
        id: 'seg-1',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'Second sentence that would previously get folded into the same paragraph.',
        startMs: 3200,
        endMs: 6200,
        confidence: -1
      },
      {
        id: 'seg-2',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'Third sentence should stay separate once the group gets too large.',
        startMs: 6400,
        endMs: 9400,
        confidence: -1
      },
      {
        id: 'seg-3',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'Fourth sentence definitely needs its own row.',
        startMs: 9600,
        endMs: 12600,
        confidence: -1
      }
    ]

    render(<TranscriptView segments={segments} status="complete" />)

    expect(
      screen.getByText(
        'First sentence with enough content to matter. Second sentence that would previously get folded into the same paragraph.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Third sentence should stay separate once the group gets too large. Fourth sentence definitely needs its own row.'
      )
    ).toBeInTheDocument()
  })

  it('merges short same-speaker fragments into a sentence-like block', () => {
    const segments: Transcript[] = [
      {
        id: 'seg-0',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'quite confident that these charts always show',
        startMs: 0,
        endMs: 2500,
        confidence: -1
      },
      {
        id: 'seg-1',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'accurate results, so I want to look',
        startMs: 2600,
        endMs: 5200,
        confidence: -1
      },
      {
        id: 'seg-2',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'into this a bit more.',
        startMs: 5300,
        endMs: 7600,
        confidence: -1
      },
      {
        id: 'seg-3',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'Okay, so what your concern is is that we are',
        startMs: 7700,
        endMs: 10200,
        confidence: -1
      },
      {
        id: 'seg-4',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'unfairly penalizing 4.x when the',
        startMs: 10300,
        endMs: 12600,
        confidence: -1
      },
      {
        id: 'seg-5',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'event applies to both 4.x and 4.x.',
        startMs: 12700,
        endMs: 15300,
        confidence: -1
      }
    ]

    render(<TranscriptView segments={segments} status="complete" />)

    expect(
      screen.getByText(
        'quite confident that these charts always show accurate results, so I want to look into this a bit more.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Okay, so what your concern is is that we are unfairly penalizing 4.x when the event applies to both 4.x and 4.x.'
      )
    ).toBeInTheDocument()
  })

  it('shows transcribing message when status is transcribing', () => {
    render(<TranscriptView segments={[]} status="transcribing" />)
    expect(screen.getByText(/transcribing/i)).toBeInTheDocument()
  })

  it('shows downloading message when status is downloading', async () => {
    window.electronAPI = createElectronApiMock({
      'whisper:get-setup-status': { phase: 'checking', percent: 0 }
    }) as any

    render(<TranscriptView segments={[]} status="downloading" />)
    expect(await screen.findByText('Checking transcription engine...')).toBeInTheDocument()
  })

  it('shows pending message when status is pending', () => {
    render(<TranscriptView segments={[]} status="pending" />)
    expect(screen.getByText(/awaiting/i)).toBeInTheDocument()
  })

  it('shows empty state when complete with no segments', () => {
    render(<TranscriptView segments={[]} status="complete" />)
    expect(screen.getByText(/no transcript/i)).toBeInTheDocument()
  })

  it('renders speaker names when speakers map is provided', () => {
    const speakers = {
      me: { label: 'Me' },
      speaker_1: { label: 'Alice' }
    }
    const segments = [
      {
        id: 's1',
        meetingId: 'm1',
        speaker: 'me',
        text: 'Hello',
        startMs: 0,
        endMs: 3000,
        confidence: -1
      },
      {
        id: 's2',
        meetingId: 'm1',
        speaker: 'speaker_1',
        text: 'Hi there',
        startMs: 3000,
        endMs: 6000,
        confidence: -1
      }
    ]
    render(<TranscriptView segments={segments} status="complete" speakers={speakers} />)
    expect(screen.getByText('Me')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('renders diarizing status', () => {
    render(<TranscriptView segments={[]} status="diarizing" />)
    expect(screen.getByText('Identifying speakers...')).toBeInTheDocument()
  })

  it('renders without speaker labels when no speakers map', () => {
    const segments = [
      {
        id: 's1',
        meetingId: 'm1',
        speaker: 'Speaker',
        text: 'Hello',
        startMs: 0,
        endMs: 3000,
        confidence: -1
      }
    ]
    render(<TranscriptView segments={segments} status="complete" />)
    expect(screen.getByText('Hello')).toBeInTheDocument()
    // Should not render a speaker name element
    expect(screen.queryByText('Speaker')).not.toBeInTheDocument()
  })
})
