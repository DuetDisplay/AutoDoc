const MAX_PER_ERROR_PER_DAY = 3
const MAX_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

interface CappedEvent {
  fingerprint?: string[]
  message?: string
  exception?: { values?: Array<{ type?: string; value?: string }> }
}

function eventKey(event: CappedEvent): string {
  if (event.fingerprint?.length) return event.fingerprint.join('|')
  const exception = event.exception?.values?.at(-1)
  const text = exception ? `${exception.type}: ${exception.value}` : (event.message ?? 'unknown')
  return text.replace(UUID, '#').replace(/\d+/g, '#').slice(0, 200)
}

/** Limits what one running app can send, so a repeating failure can't become a burst. */
export function createSentryEventCap(now: () => number = Date.now) {
  const perError = new Map<string, { windowStart: number; count: number }>()
  let sentInLastHour: number[] = []

  return {
    allow(event: CappedEvent): boolean {
      const time = now()
      sentInLastHour = sentInLastHour.filter((sentAt) => time - sentAt < HOUR_MS)
      for (const [key, entry] of perError) {
        if (time - entry.windowStart >= DAY_MS) perError.delete(key)
      }

      const key = eventKey(event)
      const entry = perError.get(key)
      if (entry && entry.count >= MAX_PER_ERROR_PER_DAY) return false
      if (sentInLastHour.length >= MAX_PER_HOUR) return false

      sentInLastHour.push(time)
      perError.set(key, { windowStart: entry?.windowStart ?? time, count: (entry?.count ?? 0) + 1 })
      return true
    }
  }
}
