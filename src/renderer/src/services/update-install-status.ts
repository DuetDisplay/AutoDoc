import type { MessageKey } from '../../../shared/i18n'

// Main-process block reasons are stable diagnostic strings, translated at render time
// so an already-visible update prompt follows changes to the UI language.
const reasonKeys: ReadonlyMap<string, MessageKey> = new Map([
  ['Finish your recording before restarting.', 'settings.finishRecordingBeforeRestart'],
  ['AutoDoc is starting. Try again shortly.', 'update.startingBeforeRestart'],
  [
    'AutoDoc is processing your meeting. Restart when it finishes.',
    'update.processingBeforeRestart'
  ],
  ['Wait for the model download to finish before restarting.', 'update.downloadBeforeRestart'],
  ['AutoDoc is saving your recording.', 'update.savingBeforeRestart']
])

export function updateInstallBlockMessage(
  reason: string | undefined,
  t: (key: MessageKey) => string
): string | undefined {
  if (!reason) return undefined
  const key = reasonKeys.get(reason)
  return key ? t(key) : reason
}
