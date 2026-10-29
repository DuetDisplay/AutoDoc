import { displaySpeakerLabel } from '../services/speaker-label'
import { useT } from '../services/i18n'
import { useRef, useState } from 'react'
import { SPEAKER_COLORS } from '../../../shared/constants'
import { SpeakerRenameDropdown } from './SpeakerRenameDropdown'
import type { SpeakerMap } from '../../../shared/types'

function getSpeakerColor(speakerId: string, speakerIds: string[]): string {
  if (speakerId === 'me') return SPEAKER_COLORS[0].border
  const index = speakerIds.filter((id) => id !== 'me').indexOf(speakerId)
  const colorIndex = (index >= 0 ? index + 1 : 1) % SPEAKER_COLORS.length
  return SPEAKER_COLORS[colorIndex].border
}

interface SpeakerLegendProps {
  speakers: SpeakerMap
  speakerIds: string[]
  onRename: (speakerId: string, newLabel: string) => void
}

export function SpeakerLegend({ speakers, speakerIds, onRename }: SpeakerLegendProps) {
  const t = useT()

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const renameAnchor = useRef<HTMLButtonElement | null>(null)

  return (
    <div className="flex min-w-0 max-w-full gap-4 px-4 py-3 bg-bg-card border border-border rounded-xl mb-3 items-center flex-wrap">
      <span className="text-[11px] text-ink-faint">{t('ui.speakers')}</span>
      {speakerIds.map((id) => {
        const info = speakers[id]
        const color = getSpeakerColor(id, speakerIds)
        return (
          <div key={id} className="relative flex min-w-0 max-w-full items-center gap-1.5">
            <div className="w-2 h-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="min-w-0 text-[12px] text-ink font-medium [overflow-wrap:anywhere]">
              {displaySpeakerLabel(id, info, t)}
            </span>
            {id !== 'me' && (
              <button
                onClick={(event) => {
                  renameAnchor.current = event.currentTarget
                  setRenamingId(renamingId === id ? null : id)
                }}
                className="i18n-btn shrink-0 text-[10px] text-ink-faint border border-border rounded px-1.5 py-px hover:text-ink-muted transition-colors"
              >
                {t('ui.rename')}
              </button>
            )}
            {renamingId === id && (
              <SpeakerRenameDropdown
                anchorRef={renameAnchor}
                suggestions={info?.suggestions}
                onRename={(name) => onRename(id, name)}
                onClose={() => setRenamingId(null)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
