/** Llama 3.1 BPE is typically ~4 characters per English token. Directional only. */
export const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function countWords(text: string): number {
  const parts = text.trim().split(/\s+/u)
  if (parts.length === 1 && parts[0] === '') return 0
  return parts.length
}
