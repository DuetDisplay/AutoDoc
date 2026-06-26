const MANUAL_UPDATE_CHECK_EVENT = 'autodoc:manual-update-check'

export function notifyManualUpdateCheckStarted(): void {
  window.dispatchEvent(new Event(MANUAL_UPDATE_CHECK_EVENT))
}

export function onManualUpdateCheckStarted(listener: () => void): () => void {
  window.addEventListener(MANUAL_UPDATE_CHECK_EVENT, listener)
  return () => window.removeEventListener(MANUAL_UPDATE_CHECK_EVENT, listener)
}
