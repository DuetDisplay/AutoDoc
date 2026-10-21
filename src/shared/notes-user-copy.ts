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

const COPY: Record<NotesUserFailureKind, NotesUserCopy> = {
  empty: {
    title: 'No notes were generated',
    body: 'There wasn’t enough conversation to turn into notes. Your transcript is still available.'
  },
  // The model ran but nothing it wrote was supported by the transcript. This also covers a long
  // meeting where the model returned nothing, so it must not claim the conversation was short.
  'nothing-found': {
    title: 'No notes were generated',
    body: 'AutoDoc didn’t find anything in the transcript to turn into notes. You can retry, and your transcript is still available.'
  },
  memory: {
    title: 'Not enough available memory',
    body: 'Your computer doesn’t have enough free RAM to generate notes. Close other apps, then retry.'
  },
  engine: {
    title: 'Notes couldn’t finish',
    body: 'The notes engine wasn’t ready yet. Stay connected if a download is in progress, then try again.'
  },
  generic: {
    title: 'Notes couldn’t finish',
    body: 'AutoDoc hit a problem writing notes this time. Your transcript is still available.'
  },
  layout: {
    title: 'Your notes are ready in a basic format',
    body: 'AutoDoc hit an error while preparing the topic layout, so your generated notes are shown in categories below. Your transcript is still available.'
  }
}

export function notesUserCopy(kind: NotesUserFailureKind): NotesUserCopy {
  return COPY[kind]
}

export function notesFailureKindFromCode(errorCode: string | undefined): NotesUserFailureKind {
  if (errorCode === 'ollama-insufficient-memory') return 'memory'
  if (errorCode === 'ollama-unavailable' || errorCode === 'ollama-model-setup') return 'engine'
  if (errorCode === 'scan_or_persist') return 'layout'
  if (errorCode === 'no_notes_detected') return 'empty'
  if (errorCode === 'llm-empty-output') return 'nothing-found'
  return 'generic'
}
