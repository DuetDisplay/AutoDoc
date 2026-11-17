import { useEffect } from 'react'
import { create } from 'zustand'

// null until the main process has decided, so nothing shows and then disappears.
const useAvailabilityStore = create<{ available: boolean | null }>(() => ({ available: null }))

let subscribed = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  // The decision is stable for the launch; a later push only ever turns Ask AI off.
  window.electronAPI.on('chat:availability-changed', (available) =>
    useAvailabilityStore.setState({ available })
  )
  void window.electronAPI.invoke('chat:availability').then(
    (available) => {
      if (useAvailabilityStore.getState().available === null)
        useAvailabilityStore.setState({ available: available === true })
    },
    () => useAvailabilityStore.setState({ available: false })
  )
}

/** Whether Ask AI is offered on this machine: null while unknown. */
export function useAskAiAvailable(): boolean | null {
  useEffect(subscribe, [])
  return useAvailabilityStore((state) => state.available)
}

/** Test seam: sets the shared decision; null makes the next hook fetch it again. */
export function resetAskAiAvailabilityForTests(available: boolean | null): void {
  subscribed = available !== null
  useAvailabilityStore.setState({ available })
}
