import { translate, type MessageKey } from './i18n'
import type { UiLanguageCode } from './ui-language'

export type NotesUserFailureKind =
  | 'empty'
  | 'nothing-found'
  | 'memory'
  | 'engine'
  | 'generic'
  | 'layout'

export interface NotesUserCopy {
  title: string
  body: string
}

const COPY: Record<NotesUserFailureKind, { title: MessageKey; body: MessageKey }> = {
  empty: {
    title: 'notesFailure.emptyTitle',
    body: 'notesFailure.emptyBody'
  },
  // The model ran but nothing it wrote was supported by the transcript. This also covers a long
  // meeting where the model returned nothing, so it must not claim the conversation was short.
  'nothing-found': {
    title: 'notesFailure.emptyTitle',
    body: 'notesFailure.nothingFoundBody'
  },
  memory: {
    title: 'ui.notEnoughAvailableMemory',
    body: 'notesFailure.memoryBody'
  },
  engine: {
    title: 'notesFailure.title',
    body: 'notesFailure.engineBody'
  },
  generic: {
    title: 'notesFailure.title',
    body: 'notesFailure.genericBody'
  },
  layout: {
    title: 'notesFailure.layoutTitle',
    body: 'notesFailure.layoutBody'
  }
}

export function notesUserCopy(
  kind: NotesUserFailureKind,
  language: UiLanguageCode = 'en'
): NotesUserCopy {
  const keys = COPY[kind]
  return { title: translate(language, keys.title), body: translate(language, keys.body) }
}

export function notesFailureKindFromCode(errorCode: string | undefined): NotesUserFailureKind {
  if (errorCode === 'ollama-insufficient-memory') return 'memory'
  if (errorCode === 'ollama-unavailable' || errorCode === 'ollama-model-setup') return 'engine'
  if (errorCode === 'scan_or_persist') return 'layout'
  if (errorCode === 'no_notes_detected') return 'empty'
  if (errorCode === 'llm-empty-output') return 'nothing-found'
  return 'generic'
}
