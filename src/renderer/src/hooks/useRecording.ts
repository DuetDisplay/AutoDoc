import { useEffect, useCallback, useRef } from 'react'
import { useRecordingStore } from '../stores/recording'
import { startCapture, stopCapture } from '../services/recording-capture'
import { detectMeetingWindow } from '../services/window-detection'

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

  // Listen for auto-detection prompts to start recording
  useEffect(() => {
    const unsubscribe = window.electronAPI.on('detection:start-recording', (payload) => {
      if (!isRecording) {
        handleStart(payload.sourceId, payload.sourceName).catch((err) => {
          console.error('Auto-start recording failed:', err)
        })
      }
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording])

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
    const paths = await window.electronAPI.invoke('recording:start', sourceId, sourceNameParam)
    try {
      await startCapture(sourceId, paths.meetingId)
    } catch (err) {
      // Rollback main process state if capture fails (e.g. permission denied)
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
