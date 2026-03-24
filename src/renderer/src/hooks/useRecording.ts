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
    await startCapture(sourceId, paths.meetingId)
  }, [])

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
