import { useState } from 'react'
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
  const [renamingId, setRenamingId] = useState<string | null>(null)

  return (
    <div className="flex gap-4 px-4 py-3 bg-bg-card border border-border rounded-xl mb-3 items-center flex-wrap">
      <span className="text-[11px] text-ink-faint">Speakers:</span>
      {speakerIds.map((id) => {
        const info = speakers[id]
        const color = getSpeakerColor(id, speakerIds)
        return (
          <div key={id} className="relative flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="text-[12px] text-ink font-medium">
              {info?.label ?? id}
            </span>
            {id !== 'me' && (
              <button
                onClick={() => setRenamingId(renamingId === id ? null : id)}
                className="text-[10px] text-ink-faint border border-border rounded px-1.5 py-px hover:text-ink-muted transition-colors"
              >
                rename
              </button>
            )}
            {renamingId === id && (
              <SpeakerRenameDropdown
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
