import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { createPortal } from 'react-dom'
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import type { RecordingSource, RecordingTrackingContext } from '../../../shared/types'
import { useCalendarStore } from '../stores/calendar'
import { useRecordingPickerStore } from '../stores/recording-picker'
import { logPickerOpened, logPickerResult } from '../services/picker-diagnostics'
import { useToastStore } from '../stores/toast'
import type { RecordingStartOptions } from '../hooks/useRecording'
import {
  buildRecordingSelectionContext,
  buildRecordingTrackingContext,
  chooseAutoRecordSource,
  findActiveCalendarEvent
} from '../services/window-detection'
import { getSavedSourcePreference } from '../services/recording-source-preferences'
import { useT } from '../services/i18n'

function isUsableImageDataUrl(value: string | null | undefined): value is string {
  if (!value?.startsWith('data:image/')) return false
  const payloadStart = value.indexOf(',')
  return payloadStart >= 0 && value.slice(payloadStart + 1).trim().length > 0
}

function SourcePlaceholder({ isScreen }: { isScreen: boolean }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-testid={isScreen ? 'screen-source-placeholder' : 'window-source-placeholder'}
      className="w-20 h-12 shrink-0 rounded border border-border-subtle bg-bg-accent flex items-center justify-center text-ink-faint"
    >
      {isScreen ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="w-7 h-7"
        >
          <rect x="3.5" y="4.5" width="17" height="12" rx="1.5" />
          <path d="M9 20h6M12 16.5V20" strokeLinecap="round" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="w-7 h-7"
        >
          <rect x="4" y="4.5" width="16" height="15" rx="2" />
          <path d="M4 8.5h16M7 6.5h.01M10 6.5h.01" strokeLinecap="round" />
        </svg>
      )}
    </span>
  )
}

function SourcePreview({ source }: { source: RecordingSource }): ReactElement {
  const [failedDataUrls, setFailedDataUrls] = useState<string[]>([])
  const candidates = [
    ...(isUsableImageDataUrl(source.iconDataUrl)
      ? [{ dataUrl: source.iconDataUrl, kind: 'icon' as const }]
      : []),
    ...(isUsableImageDataUrl(source.thumbnailDataUrl)
      ? [{ dataUrl: source.thumbnailDataUrl, kind: 'thumbnail' as const }]
      : [])
  ]
  const preview = candidates.find(({ dataUrl }) => !failedDataUrls.includes(dataUrl))
  const isScreen = source.id.startsWith('screen:')

  if (!preview) {
    return <SourcePlaceholder isScreen={isScreen} />
  }

  return (
    <img
      src={preview.dataUrl}
      alt=""
      aria-hidden="true"
      data-testid="recording-source-preview"
      onError={() => setFailedDataUrls((failed) => [...failed, preview.dataUrl])}
      className={`w-20 h-12 shrink-0 rounded border border-border-subtle ${
        preview.kind === 'icon' ? 'object-contain p-2 bg-bg-accent' : 'object-cover'
      }`}
    />
  )
}

interface RecordingControlsProps {
  isRecording: boolean
  onStartRecording: (
    sourceId: string,
    sourceName: string,
    selectionContext?: ReturnType<typeof buildRecordingSelectionContext>,
    trackingContext?: RecordingTrackingContext | null,
    startOptions?: RecordingStartOptions
  ) => Promise<unknown>
  onStopRecording: () => void
  onFetchSources: () => Promise<RecordingSource[]>
}

export function RecordingControls({
  isRecording,
  onStartRecording,
  onStopRecording,
  onFetchSources
}: RecordingControlsProps): ReactElement {
  const t = useT()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const pickerTitleId = useId()
  const [loading, setLoading] = useState(false)
  const events = useCalendarStore((state) => state.events)
  const {
    isOpen: showPicker,
    titleKey,
    subtitleKey,
    sources,
    detectedId,
    suggestionLabelKey,
    selectionContext: pickerSelectionContext,
    trigger,
    scoredSourceIds,
    requestId: pickerRequestId,
    diagnosticTrigger,
    openPicker,
    closePicker
  } = useRecordingPickerStore()
  const placement = useAnchoredPopover(showPicker, triggerRef, 320, 384)
  const cancelPickerRef = useRef<() => void>(closePicker)
  useEffect(() => {
    if (!showPicker) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelPickerRef.current()
        triggerRef.current?.focus()
      } else if (event.key === 'Tab') {
        const buttons =
          pickerRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        if (!buttons?.length) return
        const first = buttons[0],
          last = buttons[buttons.length - 1]
        if (
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      closePicker()
    }
  }, [showPicker, closePicker])
  useEffect(() => {
    if (showPicker && placement.visibility !== 'hidden')
      pickerRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [showPicker, placement.visibility])
  const orderedSources = useMemo(() => {
    if (!detectedId) return sources

    const detectedSource = sources.find((source) => source.id === detectedId)
    if (!detectedSource) return sources

    return [detectedSource, ...sources.filter((source) => source.id !== detectedId)]
  }, [detectedId, sources])
  const selectionContext = useMemo(
    () => pickerSelectionContext ?? buildRecordingSelectionContext(findActiveCalendarEvent(events)),
    [events, pickerSelectionContext]
  )

  const handleRecordClick = async (): Promise<void> => {
    setLoading(true)
    try {
      const fetchedSources = await onFetchSources()
      if (fetchedSources.length === 0) {
        throw new Error(
          'No capture sources were available. Screen recording permission may be missing.'
        )
      }
      const selection = chooseAutoRecordSource(
        fetchedSources,
        selectionContext,
        getSavedSourcePreference(selectionContext)
      )

      openPicker({
        titleKey: 'recording.selectWindowToRecord',
        selectionContext,
        subtitleKey:
          selection.source && selection.confidence === 'high'
            ? 'recording.highlightedWindow'
            : null,
        sources: fetchedSources,
        detectedId: selection.source?.id ?? null,
        suggestionLabelKey: selection.source
          ? selection.confidence === 'high'
            ? 'recording.detectedMeeting'
            : 'recording.suggestedWindow'
          : null,
        scoredSourceIds: selection.candidateSourceIds,
        diagnosticTrigger: 'manual'
      })
      logPickerOpened({
        trigger: 'manual',
        requestId: null,
        eventId: selectionContext.eventId,
        sourceCount: fetchedSources.length,
        suggestionHighlighted: selection.source !== null
      })
    } catch (err) {
      console.warn('Failed to list recording sources:', err)
      useToastStore.getState().showToast({
        type: 'screen',
        message: t('recording.screenPermission'),
        messageKey: 'recording.screenPermission',
        action: {
          label: t('upcoming.openSettings'),
          labelKey: 'upcoming.openSettings',
          type: 'open-settings',
          target: 'screen'
        }
      })
    } finally {
      setLoading(false)
    }
  }

  const handleCancelPicker = (): void => {
    logPickerResult({
      trigger: diagnosticTrigger,
      requestId: pickerRequestId,
      eventId: selectionContext.eventId,
      result: 'cancelled'
    })
    closePicker()
  }
  cancelPickerRef.current = handleCancelPicker

  const handleSourceSelect = (source: RecordingSource): void => {
    const scoredIndex = scoredSourceIds.indexOf(source.id)
    logPickerResult({
      trigger: diagnosticTrigger,
      requestId: pickerRequestId,
      eventId: selectionContext.eventId,
      result: 'picked',
      pickedIndex: scoredIndex >= 0 ? scoredIndex : null,
      pickedWasSuggested: source.id === detectedId,
      sourceType: source.id.startsWith('screen:') ? 'screen' : 'window'
    })
    closePicker()
    const detectedSource = detectedId
      ? (sources.find((candidate) => candidate.id === detectedId) ?? null)
      : null
    void onStartRecording(
      source.id,
      source.name,
      selectionContext,
      buildRecordingTrackingContext(source, detectedSource, selectionContext, trigger),
      // The user picked this window, so remember it for the meeting.
      { rememberSource: true }
    )
  }

  if (isRecording) {
    return (
      <button
        onClick={onStopRecording}
        className="i18n-btn text-[11px] font-medium text-on-brand bg-status-recording px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
      >
        {t('recording.stopRecording')}
      </button>
    )
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={showPicker}
        onClick={handleRecordClick}
        disabled={loading}
        className="i18n-btn text-[11px] font-medium text-on-brand bg-sage px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {loading ? t('common.loading') : t('recording.record')}
      </button>

      {showPicker &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={handleCancelPicker} />
            <div
              ref={pickerRef}
              role="dialog"
              aria-labelledby={pickerTitleId}
              style={placement}
              className="fixed z-50 bg-bg-card border border-border rounded-xl shadow-lg p-3 overflow-y-auto"
            >
              <p
                id={pickerTitleId}
                className="text-[11px] font-medium text-ink-muted mb-1 text-pretty [overflow-wrap:anywhere]"
              >
                {t(titleKey)}
              </p>
              {subtitleKey && (
                <p className="text-[10px] text-ink-faint mb-2 text-pretty [overflow-wrap:anywhere]">
                  {t(subtitleKey)}
                </p>
              )}
              <div className="flex flex-col gap-1.5">
                {orderedSources.map((source) => (
                  <button
                    key={source.id}
                    onClick={() => handleSourceSelect(source)}
                    className={`flex items-center gap-3 p-2 rounded-lg hover:bg-bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage transition-colors text-left ${
                      source.id === detectedId ? 'ring-2 ring-ink bg-bg-accent' : ''
                    }`}
                  >
                    <SourcePreview source={source} />
                    <div className="flex flex-col flex-1 min-w-0">
                      <span className="i18n-ellipsis text-[12px] text-ink" title={source.name}>
                        {source.name}
                      </span>
                      {source.id === detectedId && suggestionLabelKey && (
                        <span className="text-[10px] text-status-connected font-medium text-pretty [overflow-wrap:anywhere]">
                          {t(suggestionLabelKey)}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  )
}
