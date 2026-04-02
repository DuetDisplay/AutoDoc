export function classifyError(rawError: string): string {
  const error = rawError.toLowerCase()

  if (error.includes('unable to authenticate') || error.includes('unsupported state')) {
    return 'key-mismatch'
  }
  if (error.includes('whisper') && (error.includes('not found') || error.includes('spawn failed'))) {
    return 'whisper-not-found'
  }
  if (error.includes('whisper') && error.includes('exited with code')) {
    return 'whisper-crash'
  }
  if (error.includes('ffmpeg')) {
    return 'ffmpeg-error'
  }
  if (error.includes('enospc') || error.includes('no space')) {
    return 'disk-full'
  }
  if (error.includes('eacces') || error.includes('permission')) {
    return 'permission-denied'
  }
  if (error.includes('llm returned empty')) {
    return 'llm-empty-output'
  }
  if (error.includes('context overflow') || error.includes('model issue')) {
    return 'llm-context-overflow'
  }

  return 'unknown'
}
