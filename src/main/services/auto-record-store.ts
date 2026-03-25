import Store from 'electron-store'
import type { AutoRecordMode } from '../../shared/types'

const store = new Store({ name: 'autodoc-auto-record' })

// Keys: event IDs for 'once', recurring event IDs for 'series'
const ONCE_KEY = 'auto_record_once'
const SERIES_KEY = 'auto_record_series'

function getSet(key: string): Set<string> {
  const arr = store.get(key, []) as string[]
  return new Set(arr)
}

function saveSet(key: string, s: Set<string>): void {
  store.set(key, [...s])
}

export function setAutoRecord(eventId: string, recurringEventId: string | null, mode: AutoRecordMode): void {
  const onceSet = getSet(ONCE_KEY)
  const seriesSet = getSet(SERIES_KEY)

  // Clear previous settings for this event
  onceSet.delete(eventId)
  if (recurringEventId) seriesSet.delete(recurringEventId)

  if (mode === 'once') {
    onceSet.add(eventId)
  } else if (mode === 'series' && recurringEventId) {
    seriesSet.add(recurringEventId)
  }

  saveSet(ONCE_KEY, onceSet)
  saveSet(SERIES_KEY, seriesSet)
}

export function getAutoRecordMode(eventId: string, recurringEventId: string | null): AutoRecordMode {
  const onceSet = getSet(ONCE_KEY)
  if (onceSet.has(eventId)) return 'once'

  if (recurringEventId) {
    const seriesSet = getSet(SERIES_KEY)
    if (seriesSet.has(recurringEventId)) return 'series'
  }

  return 'off'
}

export function isAutoRecordEnabled(eventId: string, recurringEventId: string | null): boolean {
  return getAutoRecordMode(eventId, recurringEventId) !== 'off'
}
