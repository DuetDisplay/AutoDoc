import { getMeetingLanguageDefinition } from '../../shared/meeting-language'

export function chatLanguageInstruction(language: unknown): string {
  const { label } = getMeetingLanguageDefinition(language)
  return `Write the entire answer in ${label}, the user's selected meeting language, even when the question, conversation history, or source material is in another language. Preserve meeting titles, names, URLs, and quoted evidence.`
}
