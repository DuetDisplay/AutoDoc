import { stopCapture, isCapturing } from './recording-capture'

let pendingStop: Promise<void> | null = null
const pendingStarts = new Set<Promise<unknown>>()

export function trackRecordingStart<T>(pending: Promise<T>): Promise<T> {
  pendingStarts.add(pending)
  void pending.then(
    () => pendingStarts.delete(pending),
    () => pendingStarts.delete(pending)
  )
  return pending
}

/** Join UI, auto-stop, tray and quit requests; flush chunks before Mac main stop. */
export function finishRecording(): Promise<void> {
  if (pendingStop) return pendingStop
  const pending = (async () => {
    await Promise.allSettled([...pendingStarts])
    const state = await window.electronAPI.invoke('recording:get-state')
    if (!state.isRecording && !isCapturing()) return
    const windows =
      navigator.platform.startsWith('Win') ||
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform === 'Windows'
    const stopped =
      windows && state.isRecording ? await window.electronAPI.invoke('recording:stop') : null
    await stopCapture()
    if (stopped) await window.electronAPI.invoke('recording:finalize-stop', stopped.meetingId)
    else if (state.isRecording) await window.electronAPI.invoke('recording:stop')
  })()
  pendingStop = pending
  void pending.then(
    () => {
      pendingStop = null
    },
    () => {
      pendingStop = null
    }
  )
  return pending
}
