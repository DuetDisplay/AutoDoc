import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TranscriptionStep } from '../TranscriptionStep'
import { I18nProvider } from '../../../services/i18n'
import { applyDocumentLanguage } from '../../../services/document-language'
import { translate } from '../../../../../shared/i18n'
import type { WhisperSetupStatus } from '../../../../../shared/types'

describe('TranscriptionStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({ phase: 'checking', percent: 0 })
      }
      return Promise.resolve({})
    })
  })

  it('shows managed setup messaging during installation', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'downloading-whisper',
          percent: 42
        })
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByText('Setting Up Transcription')).toBeInTheDocument()
    expect(
      screen.getByText(/local speech engine and local speaker identification/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/downloading transcription engine\.\.\. 42%/i)).toBeInTheDocument()
    expect(screen.queryByText(/brew install/i)).not.toBeInTheDocument()
  })

  it('sets expectations when a low-memory Mac profile is selected', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'downloading-model',
          percent: 38,
          backend: 'mlx-whisper',
          backendLabel: 'Apple Silicon optimized transcription',
          macProcessingProfileId: 'mac-low-spec',
          macProcessingProfileReason: 'Apple Silicon Mac has 8 GB memory'
        })
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByText('Optimized for this Mac')).toBeInTheDocument()
    expect(screen.getByText(/this computer has limited memory/i)).toBeInTheDocument()
    expect(
      screen.getByText(/process microphone and system audio one at a time/i)
    ).toBeInTheDocument()
  })

  it('sets expectations when a low-memory Windows profile is selected', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'downloading-model',
          percent: 38,
          backend: 'whisper-cpp',
          backendLabel: 'Local transcription',
          windowsProcessingProfileId: 'win-low-spec',
          windowsProcessingProfileReason: 'Windows PC has 8 GB memory',
          notesModel: 'llama3.2:3b'
        })
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByText('Optimized for this PC')).toBeInTheDocument()
    expect(screen.getByText(/this computer has limited memory/i)).toBeInTheDocument()
    expect(
      screen.getByText(/process microphone and system audio one at a time/i)
    ).toBeInTheDocument()
  })

  it('starts transcription setup when onboarding reaches the step', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'checking',
          percent: 0
        })
      }
      if (channel === 'whisper:retry-setup') {
        return Promise.resolve()
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('whisper:retry-setup')
    })
  })

  it('waits for confirmation when setup is already ready', async () => {
    vi.useFakeTimers()
    const onNext = vi.fn()

    try {
      vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
        if (channel === 'whisper:get-setup-status') {
          return Promise.resolve({
            phase: 'ready',
            percent: 100
          })
        }
        return Promise.resolve({})
      })

      await act(async () => {
        render(<TranscriptionStep onNext={onNext} />)
        await Promise.resolve()
      })

      expect(screen.getByRole('heading', { name: 'Transcription Ready' })).toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(2000)
      })

      expect(onNext).not.toHaveBeenCalled()

      await act(async () => {
        screen.getByRole('button', { name: /^continue$/i }).click()
      })

      expect(onNext).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores progress from the previous language after returning to the picker', async () => {
    let progress!: (status: unknown) => Promise<void>
    vi.mocked(window.electronAPI.on).mockImplementation((_channel, callback) => {
      progress = callback as typeof progress
      return vi.fn()
    })
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'prefs:get-meeting-language'
          ? 'es'
          : {
              phase: 'ready',
              percent: 100,
              meetingLanguage: 'fr'
            }
      )
    )
    render(<TranscriptionStep onNext={vi.fn()} />)
    await waitFor(() =>
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('whisper:retry-setup')
    )
    await act(async () => {
      await progress({ phase: 'ready', percent: 100, meetingLanguage: 'fr' })
    })
    expect(screen.queryByText('Transcription Ready')).not.toBeInTheDocument()
    await act(async () => {
      await progress({ phase: 'ready', percent: 100, meetingLanguage: 'es' })
    })
    expect(screen.getByText('Transcription Ready')).toBeInTheDocument()
  })

  it('auto-retries managed setup failures before surfacing a manual retry', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'error',
          percent: 0,
          error: 'Download request failed'
        })
      }
      if (channel === 'whisper:retry-setup') {
        return Promise.resolve()
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByText('Still finishing transcription setup')).toBeInTheDocument()
    expect(screen.queryByText('We hit a setup issue')).not.toBeInTheDocument()
    expect(screen.queryByText('Retry')).not.toBeInTheDocument()
    expect(screen.queryByText(/Open Terminal/i)).not.toBeInTheDocument()

    await waitFor(
      () => {
        expect(window.electronAPI.invoke).toHaveBeenCalledWith('whisper:retry-setup')
      },
      { timeout: 4000 }
    )

    expect(
      await screen.findByText(
        /continue - this will finish in the background/i,
        {},
        { timeout: 4000 }
      )
    ).toBeInTheDocument()
  }, 10000)

  it('stops automatic retries after repeated zero-progress setup failures', async () => {
    vi.useFakeTimers()

    let whisperProgressHandler:
      | ((status: { phase: string; percent: number; error?: string | null }) => Promise<void>)
      | null = null

    vi.mocked(window.electronAPI.on).mockImplementation((channel: string, callback) => {
      if (channel === 'whisper:setup-progress') {
        whisperProgressHandler = callback as typeof whisperProgressHandler
      }
      return vi.fn()
    })

    let retrySetupCalls = 0
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'checking',
          percent: 0
        })
      }
      if (channel === 'whisper:retry-setup') {
        retrySetupCalls += 1
        return Promise.resolve({})
      }
      return Promise.resolve({})
    })

    try {
      await act(async () => {
        render(<TranscriptionStep onNext={vi.fn()} />)
        await Promise.resolve()
      })

      expect(retrySetupCalls).toBe(1)
      expect(whisperProgressHandler).not.toBeNull()

      await act(async () => {
        await whisperProgressHandler?.({
          phase: 'error',
          percent: 0,
          error: 'Audio tools missing'
        })
      })

      expect(screen.getByText('Still finishing transcription setup')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500)
      })
      expect(retrySetupCalls).toBe(2)

      await act(async () => {
        await whisperProgressHandler?.({ phase: 'downloading-ffmpeg', percent: 0 })
        await whisperProgressHandler?.({
          phase: 'error',
          percent: 0,
          error: 'Audio tools missing'
        })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500)
      })
      expect(retrySetupCalls).toBe(3)

      await act(async () => {
        await whisperProgressHandler?.({ phase: 'downloading-ffmpeg', percent: 0 })
        await whisperProgressHandler?.({
          phase: 'error',
          percent: 0,
          error: 'Audio tools missing'
        })
      })

      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500)
      })
      expect(retrySetupCalls).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  }, 10000)

  it('says the disk is full when setup fails for lack of space', async () => {
    vi.useFakeTimers()
    let progress: ((status: Record<string, unknown>) => Promise<void>) | null = null
    vi.mocked(window.electronAPI.on).mockImplementation((channel: string, callback) => {
      if (channel === 'whisper:setup-progress') progress = callback as typeof progress
      return vi.fn()
    })
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status')
        return Promise.resolve({ phase: 'checking', percent: 0 })
      return Promise.resolve({})
    })
    const full = { phase: 'error', percent: 0, error: 'ENOSPC', errorKind: 'disk-full' }

    try {
      await act(async () => {
        render(<TranscriptionStep onNext={vi.fn()} />)
        await Promise.resolve()
      })
      for (let attempt = 0; attempt < 3; attempt++) {
        await act(async () => {
          await progress?.(full)
          await vi.advanceTimersByTimeAsync(1500)
        })
      }
      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent('Not enough space to set up transcription')
      expect(alert).toHaveTextContent('Your computer is almost out of disk space.')
      expect(screen.queryByText("You're offline")).not.toBeInTheDocument()
      expect(screen.queryByText('Still finishing transcription setup')).not.toBeInTheDocument()
      vi.mocked(window.electronAPI.invoke).mockClear()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await Promise.resolve()
      })
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('whisper:retry-setup')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  }, 10000)

  it('shows the disk-full alert at once, and other errors still show the retry card', async () => {
    vi.useFakeTimers()
    let progress: ((status: Record<string, unknown>) => Promise<void>) | null = null
    vi.mocked(window.electronAPI.on).mockImplementation((channel: string, callback) => {
      if (channel === 'whisper:setup-progress') progress = callback as typeof progress
      return vi.fn()
    })
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status')
        return Promise.resolve({ phase: 'checking', percent: 0 })
      return Promise.resolve({})
    })
    try {
      await act(async () => {
        render(<TranscriptionStep onNext={vi.fn()} />)
        await Promise.resolve()
      })
      await act(async () => {
        await progress?.({ phase: 'error', percent: 0, error: 'ENOSPC', errorKind: 'disk-full' })
      })
      expect(screen.queryByText('Still finishing transcription setup')).not.toBeInTheDocument()
      expect(screen.getByRole('alert')).toBeInTheDocument()
      await act(async () => {
        await progress?.({ phase: 'error', percent: 0, error: 'boom' })
      })
      expect(screen.getByText('Still finishing transcription setup')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  }, 10000)

  it('says the machine is offline when the download cannot reach the server', async () => {
    vi.useFakeTimers()
    let progress:
      | ((status: { phase: string; percent: number; error?: string }) => Promise<void>)
      | null = null
    vi.mocked(window.electronAPI.on).mockImplementation((channel: string, callback) => {
      if (channel === 'whisper:setup-progress') progress = callback as typeof progress
      return vi.fn()
    })
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status')
        return Promise.resolve({ phase: 'checking', percent: 0 })
      if (channel === 'prefs:get-meeting-language') return Promise.resolve('de')
      if (channel === 'whisper:get-windows-meeting-language-availability') {
        return Promise.resolve({ availability: 'available', reason: null })
      }
      return Promise.resolve({})
    })
    const offline = { phase: 'error', percent: 0, error: 'fetch failed' }

    try {
      await act(async () => {
        render(<TranscriptionStep onNext={vi.fn()} />)
        await Promise.resolve()
      })
      for (let attempt = 0; attempt < 3; attempt++) {
        await act(async () => {
          await progress?.(offline)
          await vi.advanceTimersByTimeAsync(1500)
        })
      }

      expect(screen.getByText("You're offline")).toBeInTheDocument()
      expect(
        screen.getByText(
          'Connect to the internet to download the German speech model, then press Retry.'
        )
      ).toBeInTheDocument()
      expect(screen.getByText('No internet connection')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  }, 10000)

  it('keeps the background-continue affordance for in-progress setup', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
        if (channel === 'whisper:get-setup-status') {
          return Promise.resolve({
            phase: 'downloading-model',
            percent: 10
          })
        }
        return Promise.resolve({})
      })

      await act(async () => {
        render(<TranscriptionStep onNext={vi.fn()} />)
        await Promise.resolve()
      })

      expect(screen.queryByText(/continue/i)).not.toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })

      expect(screen.getByText(/continue - this will finish in the background/i)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops setup and offers another language when a non-English route is locked', async () => {
    vi.useFakeTimers()
    const onChooseLanguage = vi.fn()
    let whisperProgressHandler:
      | ((status: { phase: string; percent: number; error?: string | null }) => Promise<void>)
      | null = null

    vi.mocked(window.electronAPI.on).mockImplementation((channel: string, callback) => {
      if (channel === 'whisper:setup-progress') {
        whisperProgressHandler = callback as typeof whisperProgressHandler
      }
      return vi.fn()
    })

    let retrySetupCalls = 0
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-meeting-language') return Promise.resolve('es')
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'checking',
          percent: 0
        })
      }
      if (channel === 'whisper:retry-setup') {
        retrySetupCalls += 1
        return Promise.resolve({})
      }
      if (channel === 'whisper:get-windows-meeting-language-availability') {
        return Promise.resolve({
          availability: 'locked',
          reason: 'Spanish needs a supported graphics card on this PC.',
          reasonCode: 'needs-supported-graphics-card',
          engineId: null,
          firstUseDownloadBytes: 0
        })
      }
      return Promise.resolve({})
    })

    try {
      await act(async () => {
        render(<TranscriptionStep onNext={vi.fn()} onChooseLanguage={onChooseLanguage} />)
        await Promise.resolve()
      })

      expect(retrySetupCalls).toBe(1)
      expect(whisperProgressHandler).not.toBeNull()

      await act(async () => {
        await whisperProgressHandler?.({
          phase: 'error',
          percent: 0,
          error: 'whisper-turbo-cuda self-test failed'
        })
      })

      expect(
        screen.getByRole('heading', { name: "This language isn't available on this PC" })
      ).toBeInTheDocument()
      expect(
        screen.getAllByText('Spanish needs a supported graphics card on this PC.').length
      ).toBeGreaterThan(0)
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500)
      })
      expect(retrySetupCalls).toBe(1)
      expect(
        screen.queryByText(/continue - this will finish in the background/i)
      ).not.toBeInTheDocument()

      await act(async () => {
        screen.getByRole('button', { name: 'Choose another language' }).click()
      })
      expect(onChooseLanguage).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still auto-retries a non-English setup failure when the language is available', async () => {
    vi.useFakeTimers()
    let whisperProgressHandler:
      | ((status: { phase: string; percent: number; error?: string | null }) => Promise<void>)
      | null = null

    vi.mocked(window.electronAPI.on).mockImplementation((channel: string, callback) => {
      if (channel === 'whisper:setup-progress') {
        whisperProgressHandler = callback as typeof whisperProgressHandler
      }
      return vi.fn()
    })

    let retrySetupCalls = 0
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-meeting-language') return Promise.resolve('es')
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'checking',
          percent: 0
        })
      }
      if (channel === 'whisper:retry-setup') {
        retrySetupCalls += 1
        return Promise.resolve({})
      }
      if (channel === 'whisper:get-windows-meeting-language-availability') {
        return Promise.resolve({
          availability: 'available',
          reason: null,
          engineId: 'whisper-turbo-cuda',
          firstUseDownloadBytes: 0
        })
      }
      return Promise.resolve({})
    })

    try {
      await act(async () => {
        render(<TranscriptionStep onNext={vi.fn()} />)
        await Promise.resolve()
      })

      expect(retrySetupCalls).toBe(1)

      await act(async () => {
        await whisperProgressHandler?.({
          phase: 'error',
          percent: 0,
          error: 'whisper-turbo-cuda self-test failed'
        })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500)
      })
      expect(retrySetupCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a slower-CPU note when a non-English language is ready on the processor', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-meeting-language') return Promise.resolve('es')
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'ready',
          percent: 100
        })
      }
      if (channel === 'whisper:get-windows-meeting-language-availability') {
        return Promise.resolve({
          availability: 'slower',
          reason: null,
          engineId: 'whisper-turbo-cpu',
          firstUseDownloadBytes: 0
        })
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Transcription Ready' })).toBeInTheDocument()
    expect(
      await screen.findByText(
        'This PC will transcribe this language on the processor, so it will be slower.'
      )
    ).toBeInTheDocument()
  })

  it('does not show a slower-CPU note when a non-English language is available', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-meeting-language') return Promise.resolve('es')
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'ready',
          percent: 100
        })
      }
      if (channel === 'whisper:get-windows-meeting-language-availability') {
        return Promise.resolve({
          availability: 'available',
          reason: null,
          engineId: 'whisper-turbo-cuda',
          firstUseDownloadBytes: 0
        })
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Transcription Ready' })).toBeInTheDocument()
    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith(
        'whisper:get-windows-meeting-language-availability',
        'es'
      )
    })
    expect(
      screen.queryByText(/this PC will transcribe this language on the processor/i)
    ).not.toBeInTheDocument()
  })

  it('does not query Windows language availability for English setup failures', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'error',
          percent: 0,
          error: 'Download request failed'
        })
      }
      if (channel === 'whisper:retry-setup') {
        return Promise.resolve()
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByText('Still finishing transcription setup')).toBeInTheDocument()
    expect(window.electronAPI.invoke).not.toHaveBeenCalledWith(
      'whisper:get-windows-meeting-language-availability',
      expect.anything()
    )
  })
})

describe('TranscriptionStep locked language reason', () => {
  async function renderLocked(
    availability: Record<string, unknown>,
    options: { uiLanguage?: 'de' } = {}
  ) {
    let progress: ((status: WhisperSetupStatus) => Promise<void>) | null = null
    vi.mocked(window.electronAPI.on).mockImplementation((channel: string, callback) => {
      if (channel === 'whisper:setup-progress') progress = callback as typeof progress
      return vi.fn()
    })
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-ui-language') return Promise.resolve(options.uiLanguage ?? 'en')
      if (channel === 'prefs:get-meeting-language') return Promise.resolve('es')
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({ phase: 'checking', percent: 0 })
      }
      if (channel === 'whisper:get-windows-meeting-language-availability') {
        return Promise.resolve({ engineId: null, firstUseDownloadBytes: 0, ...availability })
      }
      return Promise.resolve({})
    })
    await act(async () => {
      render(
        <I18nProvider>
          <TranscriptionStep onNext={vi.fn()} onChooseLanguage={vi.fn()} />
        </I18nProvider>
      )
      await Promise.resolve()
    })
    await act(async () => {
      await progress?.({ phase: 'error', percent: 0, error: 'whisper-turbo-cuda self-test failed' })
    })
  }

  afterEach(() => {
    applyDocumentLanguage('en')
  })

  it('shows the generic text when the lock has no reason code', async () => {
    await renderLocked({
      availability: 'locked',
      reason: 'Spanish needs a supported graphics card on this PC.'
    })
    expect(
      await screen.findAllByText("This language isn't available on this PC.")
    ).not.toHaveLength(0)
    expect(screen.queryByText(/graphics card/i)).not.toBeInTheDocument()
  })

  it('localizes the reason with the localized language name', async () => {
    applyDocumentLanguage('de')
    await renderLocked(
      {
        availability: 'locked',
        reason: 'Spanish needs a supported graphics card on this PC.',
        reasonCode: 'needs-supported-graphics-card'
      },
      { uiLanguage: 'de' }
    )
    const localized = translate('de', 'picker.reasonNeedsGraphicsCard', { language: 'Spanisch' })
    expect(await screen.findAllByText(localized)).not.toHaveLength(0)
    expect(screen.queryByText(/needs a supported graphics card/i)).not.toBeInTheDocument()
  })
})
