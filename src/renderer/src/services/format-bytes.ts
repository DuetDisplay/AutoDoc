export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return 'Loading...'
  if (bytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

export function formatMeetingLanguageFirstUseDownload(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  return `About ${formatBytes(bytes)} download on first use`
}
