/** Prefixed logs for diagnosing transcript / meeting video playback and seeking. */

export const MEDIA_DEBUG_PREFIX = '[AutoDoc media]'

export function timeRangesSnapshot(r: TimeRanges): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (let i = 0; i < r.length; i++) {
    out.push({ start: r.start(i), end: r.end(i) })
  }
  return out
}

export function snapshotMediaElement(el: HTMLMediaElement) {
  return {
    tag: el.tagName,
    currentSrc: el.currentSrc?.slice(0, 160),
    readyState: el.readyState,
    networkState: el.networkState,
    error: el.error ? { code: el.error.code, message: el.error.message } : null,
    duration: el.duration,
    currentTime: el.currentTime,
    paused: el.paused,
    ended: el.ended,
    playbackRate: el.playbackRate,
    seekable: timeRangesSnapshot(el.seekable),
    buffered: timeRangesSnapshot(el.buffered),
    played: timeRangesSnapshot(el.played),
  }
}
