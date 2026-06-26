import type { RecordingSource } from '../../../shared/types'
import type { RecordingSelectionContext } from './window-detection'

export interface SavedSourcePreference {
  sourceId: string
  sourceName: string
  updatedAt: number
}

type PreferenceMap = Record<string, SavedSourcePreference>

const STORAGE_KEY = 'autodoc:recording-source-preferences'

export function getSavedSourcePreference(
  context: RecordingSelectionContext | null | undefined,
): SavedSourcePreference | null {
  if (!context) return null

  const preferences = readPreferences()
  for (const key of buildPreferenceKeys(context)) {
    const preference = preferences[key]
    if (preference) return preference
  }

  return null
}

export function saveSourcePreference(
  context: RecordingSelectionContext | null | undefined,
  source: RecordingSource,
): void {
  if (!context) return

  const keys = buildPreferenceKeys(context)
  if (keys.length === 0) return

  const preferences = readPreferences()
  const nextPreference: SavedSourcePreference = {
    sourceId: source.id,
    sourceName: source.name,
    updatedAt: Date.now(),
  }

  for (const key of keys) {
    preferences[key] = nextPreference
  }

  writePreferences(preferences)
}

function buildPreferenceKeys(context: RecordingSelectionContext): string[] {
  const keys: string[] = []

  if (context.recurringEventId) {
    keys.push(`series:${context.recurringEventId}`)
  }

  if (context.eventId) {
    keys.push(`event:${context.eventId}`)
  }

  if (context.providerHint) {
    keys.push(`provider:${context.providerHint}`)
  }

  return keys
}

function readPreferences(): PreferenceMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}

    return parsed as PreferenceMap
  } catch {
    return {}
  }
}

function writePreferences(preferences: PreferenceMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Ignore storage errors; recording still works without remembered sources.
  }
}
