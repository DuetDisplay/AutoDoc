import { useEffect, useCallback, useRef } from 'react'
import { useRecordingStore } from '../stores/recording'
import { startCapture, stopCapture } from '../services/recording-capture'
import { detectMeetingWindow } from '../services/window-detection'
import { trackEvent } from '../services/analytics'

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
    setLoadingSources,
  } = useRecordingStore()

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  const handleStart = useCallback(async (sourceId: string, sourceNameParam: string) => {
    try {
      const paths = await window.electronAPI.invoke('recording:start', sourceId, sourceNameParam)
      await startCapture(sourceId, paths.meetingId)
      trackEvent('recording_started')
      return paths
    } catch (err) {
      // Rollback main process state if capture fails (e.g. permission denied)
      stopCapture()
      await window.electronAPI.invoke('recording:stop').catch(() => {})
      reset()
      trackEvent('recording_start_failed')
      throw err
    }
  }, [reset])

  const handleStop = useCallback(async () => {
    try {
      stopCapture()
      await window.electronAPI.invoke('recording:stop')
      trackEvent('recording_stopped', { duration_seconds: useRecordingStore.getState().elapsedSeconds })
      reset()
    } catch (err) {
      trackEvent('recording_stop_failed')
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
    detectMeetingWindow,
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

  const handleStart = useCallback(async (sourceId: string, sourceNameParam: string) => {
    const paths = await window.electronAPI.invoke('recording:start', sourceId, sourceNameParam)
    try {
      await startCapture(sourceId, paths.meetingId)
    } catch (err) {
      stopCapture()
      await window.electronAPI.invoke('recording:stop')
      reset()
      throw err
    }
  }, [reset])

  const handleStop = useCallback(async () => {
    stopCapture()
    await window.electronAPI.invoke('recording:stop')
    reset()
  }, [reset])

  return {
    isRecording,
    fetchSources,
    handleStart,
    handleStop,
    detectMeetingWindow,
  }
}
