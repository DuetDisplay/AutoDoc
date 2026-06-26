import { useEffect, useCallback, useRef } from 'react'
import { useRecordingStore } from '../stores/recording'
import { startCapture, stopCapture } from '../services/recording-capture'
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
import type { RecordingSource, RecordingTrackingContext } from '../../../shared/types'

function isWindowsRenderer(): boolean {
  return (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ===
      'Windows' || navigator.platform.startsWith('Win')
  )
}

function logRecordingRenderer(message: string, context?: Record<string, unknown>): void {
  console.info('[recording-renderer]', message, {
    at: new Date().toISOString(),
    ...(context ?? {})
  })
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
    elapsedSeconds,
    sources,
    isLoadingSources,
    setRecordingState,
    tick,
    reset,
    setSources,
    setLoadingSources
  } = useRecordingStore()

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startPromiseRef = useRef<Promise<any> | null>(null)

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
      trackingContext?: RecordingTrackingContext | null
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
          await startCapture(sourceId, paths.meetingId)
          recordDiagnosticAction({
            category: 'recording',
            action: 'recording_started'
          })
          if (selectionContext) {
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

      startPromiseRef.current = startPromise
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
      const stopStartedAt = performance.now()
      const stopResult = isWindowsRenderer()
        ? await window.electronAPI.invoke('recording:stop')
        : null
      logRecordingRenderer('recording:stop returned to renderer', {
        meetingId: stopResult?.meetingId ?? null,
        elapsedMs: Math.round(performance.now() - stopStartedAt),
        isWindows: isWindowsRenderer()
      })
      await stopCapture()
      logRecordingRenderer('stopCapture finished in renderer', {
        meetingId: stopResult?.meetingId ?? null,
        elapsedMs: Math.round(performance.now() - stopStartedAt)
      })
      if (isWindowsRenderer() && stopResult) {
        await window.electronAPI.invoke('recording:finalize-stop', stopResult.meetingId)
        logRecordingRenderer('recording:finalize-stop completed in renderer', {
          meetingId: stopResult.meetingId,
          elapsedMs: Math.round(performance.now() - stopStartedAt)
        })
      } else {
        await window.electronAPI.invoke('recording:stop')
      }
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

  return {
    isRecording,
    meetingId,
    sourceName,
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
  const startPromiseRef = useRef<Promise<any> | null>(null)

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
      trackingContext?: RecordingTrackingContext | null
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
          await startCapture(sourceId, paths.meetingId)
          if (selectionContext) {
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

      startPromiseRef.current = startPromise
      return await startPromise
    },
    [reset]
  )

  const handleStop = useCallback(async () => {
    try {
      const durationSeconds = useRecordingStore.getState().elapsedSeconds
      const stopStartedAt = performance.now()
      const stopResult = isWindowsRenderer()
        ? await window.electronAPI.invoke('recording:stop')
        : null
      logRecordingRenderer('recording:stop returned to renderer (actions hook)', {
        meetingId: stopResult?.meetingId ?? null,
        elapsedMs: Math.round(performance.now() - stopStartedAt),
        isWindows: isWindowsRenderer()
      })
      await stopCapture()
      logRecordingRenderer('stopCapture finished in renderer (actions hook)', {
        meetingId: stopResult?.meetingId ?? null,
        elapsedMs: Math.round(performance.now() - stopStartedAt)
      })
      if (isWindowsRenderer() && stopResult) {
        await window.electronAPI.invoke('recording:finalize-stop', stopResult.meetingId)
        logRecordingRenderer('recording:finalize-stop completed in renderer (actions hook)', {
          meetingId: stopResult.meetingId,
          elapsedMs: Math.round(performance.now() - stopStartedAt)
        })
      } else {
        await window.electronAPI.invoke('recording:stop')
      }
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
