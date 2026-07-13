/**
 * Fast transcription quality switches Parakeet from fp32 to int8 on the same
 * backend tier. CPU Parakeet and other Windows backends are already on their
 * fast path, so the quality toggle has no effect there.
 */
export function supportsWindowsTranscriptionQualityFastMode(backend?: string): boolean {
  return backend === 'parakeet-gpu'
}
