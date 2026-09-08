/** Dev experiment only; normal Windows and every macOS request stay unchanged. */
export function windowsNotesModelExperiment(
  model: string,
  platform: NodeJS.Platform = process.platform,
  enabled = process.env.AUTODOC_TEST_NOTES_QWEN35
): { think: false; sampling: Record<string, number> } | null {
  if (platform !== 'win32' || enabled !== '1' || !/^qwen3\.5:(?:2b|4b)$/u.test(model)) return null
  // Qwen's published non-thinking general-task settings; seed is set at the call site.
  return { think: false, sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, repeat_penalty: 1 } }
}
