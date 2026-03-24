import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { SEGMENT_LABELS } from '../../../shared/constants'
import type { SegmentCategory } from '../../../shared/types'

type Tab = 'notes' | 'transcript'

const CATEGORY_ORDER: SegmentCategory[] = [
  'decision',
  'action_item',
  'information',
  'discussion',
  'status_update',
]

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const [activeTab, setActiveTab] = useState<Tab>('notes')

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <h1 className="text-[16px] font-bold text-ink tracking-[-0.02em]">
          Meeting
        </h1>
        <p className="text-[11px] text-ink-faint mt-0.5">ID: {id}</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-6">
        {(['notes', 'transcript'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3.5 py-2.5 text-[11.5px] font-semibold transition-colors ${
              activeTab === tab
                ? 'text-ink border-b-2 border-ink -mb-px'
                : 'text-ink-faint hover:text-ink-muted'
            }`}
          >
            {tab === 'notes' ? 'Notes' : 'Transcript'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'notes' ? (
          <div className="flex flex-col gap-4">
            {CATEGORY_ORDER.map((category) => (
              <div
                key={category}
                className="bg-bg-card border border-border rounded-xl p-4"
              >
                <div className="flex items-center gap-1.5 mb-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-ink" />
                  <span className="text-[11px] font-bold text-ink tracking-[0.03em] uppercase">
                    {SEGMENT_LABELS[category]}
                  </span>
                </div>
                <p className="text-[12px] text-ink-muted leading-relaxed">
                  No {SEGMENT_LABELS[category].toLowerCase()} recorded yet.
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-ink-muted">
            Transcript will appear here after processing.
          </p>
        )}
      </div>
    </div>
  )
}
