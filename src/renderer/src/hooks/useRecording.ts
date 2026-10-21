import { useEffect, useCallback, useRef } from 'react'
import { useRecordingStore } from '../stores/recording'
import { finishRecording, trackRecordingStart } from '../services/finish-recording'
import {
  startCapture,
  stopCapture,
  setUnrecoverableCaptureHandler,
  setVideoDisabledHandler
} from '../services/recording-capture'
import { detectMeetingWindow } from '../services/window-detection'
import {
  getDaysSinceFirstLaunch,
  toDurationBucket,
  trackEvent,
  trackFirstEventOnce
} from '../services/analytics'
import { recordDiagnosticAction } from '../services/diagnostic-trail'
import { saveSourcePreference } from '../services/recording-source-preferences'
import { captureRecordingStartFailure } from '../services/renderer-sentry'
import type { RecordingSelectionContext } from '../services/window-detection'
import type {
  RecordingPaths,
  RecordingSource,
  RecordingTrackingContext
} from '../../../shared/types'

export interface RecordingStartOptions {
  /**
   * Remember this window for the meeting. Only set when the user chose it themselves, never for
   * an automatic start, so a wrong automatic choice cannot outrank the real meeting window later.
   */
  rememberSource?: boolean
}

function getRecordingSourceType(sourceId: string): string {
  return sourceId.split(':', 1)[0] ?? 'unknown'
}

function getSourceSelectionMode(
  selectionContext?: RecordingSelectionContext
): 'assisted' | 'manual' {
  return selectionContext ? 'assisted' : 'manual'
}

/**
 * Full recording hook — sets up IPC listener, timer, and actions.
 * Mount this ONCE at the App level to avoid duplicate timers.
 */
export function useRecording() {
  const {
    isRecording,
    meetingId,
    sourceName,
    videoDisabled,
    elapsedSeconds,
    sources,
    isLoadingSources,
    setRecordingState,
    setVideoDisabled,
    tick,
    reset,
    setSources,
    setLoadingSources
  } = useRecordingStore()

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startPromiseRef = useRef<Promise<RecordingPaths> | null>(null)

  // Subscribe to recording state changes from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI.on('recording:status-changed', (state) => {
      setRecordingState(state)
    })

    // Get initial state
    window.electronAPI.invoke('recording:get-state').then(setRecordingState)

    return unsubscribe
  }, [setRecordingState])

  // Timer management — single source of truth for elapsed time
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(tick, 1000)
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [isRecording, tick])

  const fetchSources = useCallback(async () => {
    setLoadingSources(true)
    try {
      const fetchedSources = await window.electronAPI.invoke('recording:get-sources')
      setSources(fetchedSources)
      return fetchedSources
    } finally {
      setLoadingSources(false)
    }
  }, [setSources, setLoadingSources])

  const handleStart = useCallback(
    async (
      sourceId: string,
      sourceNameParam: string,
      selectionContext?: RecordingSelectionContext,
      trackingContext?: RecordingTrackingContext | null,
      startOptions?: RecordingStartOptions
    ) => {
      if (startPromiseRef.current) {
        return startPromiseRef.current
      }

      recordDiagnosticAction({
        category: 'recording',
        action: 'recording_start_requested',
        details: {
          sourceType: getRecordingSourceType(sourceId)
        }
      })
      trackEvent('recording_start_requested', {
        trigger: trackingContext ? 'auto_record' : 'manual',
        source_type: getRecordingSourceType(sourceId),
        source_selection_mode: getSourceSelectionMode(selectionContext)
      })
      const startPromise = (async () => {
        try {
          const paths = await window.electronAPI.invoke(
            'recording:start',
            sourceId,
            sourceNameParam,
            trackingContext ?? null
          )
          await startCapture(sourceId, paths.meetingId, sourceNameParam)
          recordDiagnosticAction({
            category: 'recording',
            action: 'recording_started'
          })
          if (selectionContext && startOptions?.rememberSource) {
            saveSourcePreference(selectionContext, {
              id: sourceId,
              name: sourceNameParam,
              thumbnailDataUrl: ''
            } satisfies RecordingSource)
          }
          trackEvent('recording_started', {
            trigger: trackingContext ? 'auto_record' : 'manual',
            source_type: getRecordingSourceType(sourceId),
            source_selection_mode: getSourceSelectionMode(selectionContext)
          })
          return paths
        } catch (err) {
          recordDiagnosticAction({
            category: 'recording',
            action: 'recording_start_failed_in_renderer'
          })
          captureRecordingStartFailure(err, {
            sourceType: getRecordingSourceType(sourceId),
            sourceSelectionMode: selectionContext ? 'assisted' : 'manual'
          })
          // Rollback main process state if capture fails (e.g. permission denied)
          await stopCapture()
          await window.electronAPI.invoke('recording:stop').catch(() => {})
          reset()
          trackEvent('recording_start_failed', {
            failure_code: 'capture_start_failed',
            source_type: getRecordingSourceType(sourceId)
          })
          throw err
        } finally {
          startPromiseRef.current = null
        }
      })()

      startPromiseRef.current = trackRecordingStart(startPromise)
      return await startPromise
    },
    [reset]
  )

  const handleStop = useCallback(async () => {
    recordDiagnosticAction({
      category: 'recording',
      action: 'recording_stop_requested',
      details: {
        durationSeconds: useRecordingStore.getState().elapsedSeconds
      }
    })
    try {
      await finishRecording()
      const durationSeconds = useRecordingStore.getState().elapsedSeconds
      const durationBucket = toDurationBucket(durationSeconds)
      trackEvent('recording_stopped', {
        duration_bucket: durationBucket
      })
      trackEvent('recording_completed', {
        duration_bucket: durationBucket
      })
      const daysSinceFirstLaunch = await getDaysSinceFirstLaunch()
      await trackFirstEventOnce('recording_completed', 'first_recording_completed', {
        days_since_first_launch: daysSinceFirstLaunch
      })
      await trackFirstEventOnce('user_activated', 'user_activated', {
        activation_reason: 'first_recording_completed',
        days_since_first_launch: daysSinceFirstLaunch
      })
      reset()
    } catch (err) {
      trackEvent('recording_stop_failed', { failure_code: 'capture_stop_failed' })
      throw err
    }
  }, [reset])

  useEffect(() => {
    setUnrecoverableCaptureHandler(handleStop)
    return () => setUnrecoverableCaptureHandler(null)
  }, [handleStop])

  useEffect(
    () =>
      window.electronAPI.on('recording:prepare-to-quit', (requestId) => {
        void (async () => {
          try {
            await startPromiseRef.current?.catch(() => {})
            if (useRecordingStore.getState().isRecording) await handleStop()
            else await finishRecording()
            window.electronAPI.send('recording:quit-ready', requestId)
          } catch (error) {
            window.electronAPI.send(
              'recording:quit-ready',
              requestId,
              error instanceof Error ? error.message : String(error)
            )
          }
        })()
      }),
    [handleStop]
  )

  useEffect(() => {
    setVideoDisabledHandler(async (disabledMeetingId) => {
      const currentState = useRecordingStore.getState()
      if (!currentState.isRecording || currentState.meetingId !== disabledMeetingId) {
        return
      }

      setVideoDisabled(true)
      await window.electronAPI.invoke('recording:video-capture-ended-early', disabledMeetingId)
    })
    return () => setVideoDisabledHandler(null)
  }, [setVideoDisabled])

  return {
    isRecording,
    meetingId,
    sourceName,
    videoDisabled,
    elapsedSeconds,
    sources,
    isLoadingSources,
    fetchSources,
    handleStart,
    handleStop,
    detectMeetingWindow
  }
}

/**
 * Lightweight hook for pages that need recording actions/state
 * but should NOT set up their own timer or IPC listener.
 */
export function useRecordingActions() {
  const isRecording = useRecordingStore((s) => s.isRecording)
  const reset = useRecordingStore((s) => s.reset)
  const setSources = useRecordingStore((s) => s.setSources)
  const setLoadingSources = useRecordingStore((s) => s.setLoadingSources)
  const startPromiseRef = useRef<Promise<RecordingPaths> | null>(null)

  const fetchSources = useCallback(async () => {
    setLoadingSources(true)
    try {
      const fetchedSources = await window.electronAPI.invoke('recording:get-sources')
      setSources(fetchedSources)
      return fetchedSources
    } finally {
      setLoadingSources(false)
    }
  }, [setSources, setLoadingSources])

  const handleStart = useCallback(
    async (
      sourceId: string,
      sourceNameParam: string,
      selectionContext?: RecordingSelectionContext,
      trackingContext?: RecordingTrackingContext | null,
      startOptions?: RecordingStartOptions
    ) => {
      if (startPromiseRef.current) {
        return startPromiseRef.current
      }

      const startPromise = (async () => {
        try {
          trackEvent('recording_start_requested', {
            trigger: trackingContext ? 'auto_record' : 'manual',
            source_type: getRecordingSourceType(sourceId),
            source_selection_mode: getSourceSelectionMode(selectionContext)
          })
          const paths = await window.electronAPI.invoke(
            'recording:start',
            sourceId,
            sourceNameParam,
            trackingContext ?? null
          )
          await startCapture(sourceId, paths.meetingId, sourceNameParam)
          if (selectionContext && startOptions?.rememberSource) {
            saveSourcePreference(selectionContext, {
              id: sourceId,
              name: sourceNameParam,
              thumbnailDataUrl: ''
            } satisfies RecordingSource)
          }
          trackEvent('recording_started', {
            trigger: trackingContext ? 'auto_record' : 'manual',
            source_type: getRecordingSourceType(sourceId),
            source_selection_mode: getSourceSelectionMode(selectionContext)
          })
          return paths
        } catch (err) {
          captureRecordingStartFailure(err, {
            sourceType: getRecordingSourceType(sourceId),
            sourceSelectionMode: selectionContext ? 'assisted' : 'manual'
          })
          trackEvent('recording_start_failed', {
            failure_code: 'capture_start_failed',
            source_type: getRecordingSourceType(sourceId)
          })
          await stopCapture()
          await window.electronAPI.invoke('recording:stop')
          reset()
          throw err
        } finally {
          startPromiseRef.current = null
        }
      })()

      startPromiseRef.current = trackRecordingStart(startPromise)
      return await startPromise
    },
    [reset]
  )

  const handleStop = useCallback(async () => {
    try {
      const durationSeconds = useRecordingStore.getState().elapsedSeconds
      await finishRecording()
      const durationBucket = toDurationBucket(durationSeconds)
      trackEvent('recording_stopped', {
        duration_bucket: durationBucket
      })
      trackEvent('recording_completed', {
        duration_bucket: durationBucket
      })
      const daysSinceFirstLaunch = await getDaysSinceFirstLaunch()
      await trackFirstEventOnce('recording_completed', 'first_recording_completed', {
        days_since_first_launch: daysSinceFirstLaunch
      })
      await trackFirstEventOnce('user_activated', 'user_activated', {
        activation_reason: 'first_recording_completed',
        days_since_first_launch: daysSinceFirstLaunch
      })
      reset()
    } catch (err) {
      trackEvent('recording_stop_failed', { failure_code: 'capture_stop_failed' })
      throw err
    }
  }, [reset])

  return {
    isRecording,
    fetchSources,
    handleStart,
    handleStop,
    detectMeetingWindow
  }
}
