export function computeRealtimeFactor(
  audioDurationSec: number,
  wallSeconds: number
): number | null {
  if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) {
    return null
  }
  if (!Number.isFinite(wallSeconds) || wallSeconds <= 0) {
    return null
  }

  return Number((audioDurationSec / wallSeconds).toFixed(2))
}
