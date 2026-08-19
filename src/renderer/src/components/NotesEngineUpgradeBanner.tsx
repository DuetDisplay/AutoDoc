import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { DEFAULT_OLLAMA_EMBEDDING_MODEL, LOW_SPEC_MAC_OLLAMA_MODEL } from '../../../shared/constants'
import { trackEvent } from '../services/analytics'

type BannerVariant = 'downloading' | 'offline' | 'ready'

function isEmbeddingPull(model: string | undefined): boolean {
  if (!model) return false
  return model === DEFAULT_OLLAMA_EMBEDDING_MODEL || model.includes('embedding')
}

export function NotesEngineUpgradeBanner({
  onVisibilityChange
}: {
  onVisibilityChange?: (visible: boolean) => void
}): ReactElement | null {
  const [variant, setVariant] = useState<BannerVariant | null>(null)
  const [percent, setPercent] = useState(0)
  const [sessionDismissed, setSessionDismissed] = useState(false)

  const refresh = useCallback(async () => {
    if (sessionDismissed) {
      setVariant(null)
      return
    }
    try {
      const [setup, whisper, eligible, readyDismissed] = await Promise.all([
        window.electronAPI.invoke('ollama:get-setup-status'),
        window.electronAPI.invoke('whisper:get-setup-status'),
        window.electronAPI.invoke('prefs:get-notes-engine-upgrade-eligible'),
        window.electronAPI.invoke('prefs:get-notes-engine-ready-dismissed')
      ])

      if (
        whisper?.macProcessingProfileId === 'mac-low-spec' ||
        whisper?.windowsProcessingProfileId === 'win-low-spec' ||
        whisper?.notesModel === LOW_SPEC_MAC_OLLAMA_MODEL
      ) {
        setVariant(null)
        return
      }

      const pullingPreferred =
        setup?.phase === 'pulling' && !isEmbeddingPull(setup.pullModel)
      if (pullingPreferred || (eligible && setup?.phase !== 'ready' && setup?.phase !== 'error')) {
        setPercent(typeof setup?.percent === 'number' ? setup.percent : 0)
        setVariant(navigator.onLine ? 'downloading' : 'offline')
        return
      }

      if (eligible && setup?.phase === 'ready' && readyDismissed !== true) {
        setVariant('ready')
        return
      }

      setVariant(null)
    } catch {
      setVariant(null)
    }
  }, [sessionDismissed])

  useEffect(() => {
    void refresh()
    const unsubOllama = window.electronAPI.on('ollama:setup-progress', () => {
      void refresh()
    })
    const unsubWhisper = window.electronAPI.on('whisper:setup-progress', () => {
      void refresh()
    })
    const onOnline = (): void => {
      void refresh()
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOnline)
    return () => {
      unsubOllama()
      unsubWhisper()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOnline)
    }
  }, [refresh])

  useEffect(() => {
    onVisibilityChange?.(variant !== null)
  }, [onVisibilityChange, variant])

  useEffect(() => () => onVisibilityChange?.(false), [onVisibilityChange])

  useEffect(() => {
    if (variant) {
      trackEvent('notes_engine_upgrade_shown', { phase: variant })
    }
  }, [variant])

  const dismiss = async (): Promise<void> => {
    if (!variant) return
    trackEvent('notes_engine_upgrade_dismissed', { phase: variant })
    if (variant === 'ready') {
      setVariant(null)
      try {
        await window.electronAPI.invoke('prefs:set-notes-engine-ready-dismissed', true)
      } catch (err) {
        console.warn('Failed to dismiss notes engine ready banner:', err)
        setVariant('ready')
      }
      return
    }
    setSessionDismissed(true)
    setVariant(null)
  }

  if (!variant) return null

  const title =
    variant === 'ready' ? 'New notes are ready' : 'Your notes just got a lot more readable'
  const body =
    variant === 'ready'
      ? 'Your next meeting will come back clearer and easier to scan. Existing notes stay as they are.'
      : variant === 'offline'
        ? 'We’ll install the new on-device notes engine the next time you’re online (about 2.5 GB, one time). You can keep recording — existing notes stay as they are.'
        : 'We’re installing a new on-device notes engine so your next meetings come back clearer and easier to scan. Stay connected until this finishes (about 2.5 GB, one time). Your existing notes stay as they are.'

  return (
    <div
      className="mx-6 mt-2 mb-0 rounded-xl border border-border bg-bg-card px-4 py-3 shadow-sm animate-[slideDown_300ms_ease]"
      role="status"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sage/20 bg-sage-light">
          <div className="flex h-4 items-end gap-0.5">
            <span className="h-2 w-1 rounded-full bg-sage" />
            <span className="h-4 w-1 rounded-full bg-sage" />
            <span className="h-3 w-1 rounded-full bg-sage" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[12.5px] font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{body}</p>
          {variant === 'downloading' ? (
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-accent"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-sage transition-[width] duration-300"
                style={{ width: `${Math.max(4, Math.min(100, percent))}%` }}
              />
            </div>
          ) : null}
        </div>
        <button
          onClick={() => {
            void dismiss()
          }}
          className="shrink-0 text-[12px] font-semibold text-sage transition-colors hover:text-sage-dark"
        >
          {variant === 'ready' ? 'Got it' : 'Dismiss'}
        </button>
      </div>
    </div>
  )
}
