import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type {
  MeetingNotesContent,
  MeetingNotesV2,
  NoteItem,
  NoteSection,
  NoteSourceRange
} from '../../../shared/types'
import { isMeetingSpanOnly } from '../../../shared/notes-timestamps'

type NotesOption = 'option-1' | 'option-2'

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function earliestStart(sources: readonly NoteSourceRange[]): number | null {
  if (sources.length === 0) return null
  return sources.reduce((min, source) => Math.min(min, source.startMs), sources[0].startMs)
}

function stripAgreed(text: string): { agreed: boolean; text: string } {
  const match = /^agreed:\s*/i.exec(text.trim())
  if (!match) return { agreed: false, text: text.trim() }
  return { agreed: true, text: text.trim().slice(match[0].length) }
}

function notesContent(notes: MeetingNotesV2): MeetingNotesContent {
  return {
    overview: notes.overview,
    keyTakeaways: notes.keyTakeaways,
    sections: notes.sections,
    decisions: notes.decisions,
    nextSteps: notes.nextSteps
  }
}

function createUserItem(text: string, topic: string | null = null): NoteItem {
  return {
    id: `user:${crypto.randomUUID()}`,
    title: null,
    topic,
    owner: null,
    deadline: null,
    text,
    sources: [],
    provenance: 'user-created'
  }
}

function markEdited(item: NoteItem, text: string): NoteItem {
  const sameTitle = Boolean(item.title?.trim()) && item.title?.trim() === item.text.trim()
  return {
    ...item,
    text,
    title: sameTitle ? text : item.title,
    provenance: item.provenance === 'user-created' ? 'user-created' : 'user-edited'
  }
}

function mapItems(items: NoteItem[], itemId: string, map: (item: NoteItem) => NoteItem | null): NoteItem[] {
  return items.map((item) => (item.id === itemId ? map(item) : item)).filter((item): item is NoteItem => item != null)
}

function mapNotesItems(
  notes: MeetingNotesV2,
  itemId: string,
  map: (item: NoteItem) => NoteItem | null
): MeetingNotesContent {
  return {
    ...notesContent(notes),
    keyTakeaways: mapItems(notes.keyTakeaways, itemId, map),
    decisions: mapItems(notes.decisions, itemId, map),
    nextSteps: mapItems(notes.nextSteps, itemId, map),
    sections: notes.sections.map((section) => ({
      ...section,
      keyPoints: mapItems(section.keyPoints, itemId, map),
      supportingDetails: mapItems(section.supportingDetails, itemId, map)
    }))
  }
}

function InlineEdit({
  value,
  onSave,
  className,
  style,
  as: Tag = 'span'
}: {
  value: string
  onSave?: (next: string) => void
  className?: string
  style?: CSSProperties
  as?: 'span' | 'div' | 'p' | 'h2' | 'h3'
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setDraft(value)
  }, [value])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.selectionStart = inputRef.current.value.length
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`
    }
  }, [editing])

  if (!onSave) {
    return (
      <Tag className={className} style={style}>
        {value}
      </Tag>
    )
  }

  if (editing) {
    return (
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setEditing(false)
          const trimmed = draft.trim()
          if (trimmed && trimmed !== value) onSave(trimmed)
          else setDraft(value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            inputRef.current?.blur()
          }
          if (event.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        style={style}
        className={`${className ?? ''} w-full resize-none bg-transparent outline-none`}
        rows={1}
      />
    )
  }

  return (
    <Tag className={`${className ?? ''} cursor-text`} style={style} onClick={() => setEditing(true)}>
      {value}
    </Tag>
  )
}

function JumpButton({
  sources,
  meetingSpan,
  onSeek
}: {
  sources: readonly NoteSourceRange[]
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
}): ReactElement | null {
  if (isMeetingSpanOnly(sources, meetingSpan)) return null
  const start = earliestStart(sources)
  if (start == null) return null
  return (
    <button
      type="button"
      onClick={() => onSeek(start)}
      className="text-[11px] font-medium text-ink-faint hover:text-ink"
      title={`Jump to ${formatClock(start)}`}
    >
      ▶ {formatClock(start)}
    </button>
  )
}

function NextStepRow({
  item,
  meetingSpan,
  onSeek,
  onToggle,
  onSave,
  onDelete
}: {
  item: NoteItem
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onToggle: (itemId: string, completed: boolean) => void
  onSave?: (itemId: string, text: string) => void
  onDelete?: (itemId: string) => void
}): ReactElement {
  const label = item.title?.trim() || item.text
  return (
    <div className="group flex items-start gap-2.5 py-1">
      <input
        type="checkbox"
        checked={item.completed === true}
        onChange={(event) => onToggle(item.id, event.target.checked)}
        className="mt-1 accent-[var(--sage,#7A9E7E)]"
      />
      <span className="min-w-0 flex-1">
        <InlineEdit
          value={label}
          onSave={onSave ? (text) => onSave(item.id, text) : undefined}
          className={`text-[13px] leading-relaxed ${item.completed ? 'text-ink-faint line-through' : 'text-ink'}`}
        />
        {item.owner ? <span className="ml-1.5 text-[11.5px] text-ink-muted">({item.owner})</span> : null}
      </span>
      <JumpButton sources={item.sources} meetingSpan={meetingSpan} onSeek={onSeek} />
      {onDelete ? (
        <button
          type="button"
          aria-label="Delete next step"
          onClick={() => onDelete(item.id)}
          className="opacity-0 text-[11px] text-ink-faint hover:text-clay group-hover:opacity-100"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

function Bullet({
  item,
  option,
  meetingSpan,
  onSeek,
  onSave,
  onDelete
}: {
  item: NoteItem
  option: NotesOption
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onSave?: (itemId: string, text: string) => void
  onDelete?: (itemId: string) => void
}): ReactElement {
  const parsed = stripAgreed(item.text)
  const start = earliestStart(item.sources)
  const showTime = !isMeetingSpanOnly(item.sources, meetingSpan) && start != null
  const saveText = onSave
    ? (text: string) => onSave(item.id, parsed.agreed ? `Agreed: ${text}` : text)
    : undefined

  if (option === 'option-1') {
    return (
      <div
        className={`group grid grid-cols-[52px_minmax(0,1fr)_auto] gap-x-3 py-1.5 ${parsed.agreed ? 'border-l-2 border-sage pl-3' : ''}`}
      >
        <div className="pt-0.5 text-right text-[11px] tabular-nums text-ink-faint">
          {showTime ? formatClock(start) : ''}
        </div>
        <div className="text-[13.5px] leading-relaxed text-ink">
          {parsed.agreed ? <span className="sr-only">Agreed: </span> : null}
          <InlineEdit value={parsed.text} onSave={saveText} className="text-[13.5px] leading-relaxed text-ink" />
        </div>
        {onDelete ? (
          <button
            type="button"
            aria-label="Delete note"
            data-testid={`delete-${item.id}`}
            onClick={() => onDelete(item.id)}
            className="opacity-0 text-[11px] text-ink-faint hover:text-clay group-hover:opacity-100"
          >
            ×
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="group flex items-start justify-between gap-3 py-1">
      <div className="min-w-0 text-[13.5px] leading-relaxed text-ink">
        {parsed.agreed ? (
          <span className="mr-1.5 inline-flex items-center rounded-full bg-sage-light px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sage-dark">
            Agreed
          </span>
        ) : null}
        <InlineEdit value={parsed.text} onSave={saveText} className="text-[13.5px] leading-relaxed text-ink" />
      </div>
      <div className="flex items-center gap-2">
        <JumpButton sources={item.sources} meetingSpan={meetingSpan} onSeek={onSeek} />
        {onDelete ? (
          <button
            type="button"
            aria-label="Delete note"
            data-testid={`delete-${item.id}`}
            onClick={() => onDelete(item.id)}
            className="opacity-0 text-[11px] text-ink-faint hover:text-clay group-hover:opacity-100"
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function NotesV2Document({
  notes,
  title,
  meetingSpan,
  onSeek,
  onToggleNextStep,
  onWrite
}: {
  notes: MeetingNotesV2
  title?: string
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onToggleNextStep: (itemId: string, completed: boolean) => void
  onWrite?: (content: MeetingNotesContent) => void
}): ReactElement {
  const [option, setOption] = useState<NotesOption>(() => {
    return window.localStorage.getItem('autodoc.notesV2Option') === 'option-2'
      ? 'option-2'
      : 'option-1'
  })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const openSteps = notes.nextSteps.filter((item) => item.completed !== true)
  const ownerPreview = openSteps
    .map((item) => item.owner)
    .filter((owner): owner is string => Boolean(owner))
    .filter((owner, index, all) => all.indexOf(owner) === index)
    .slice(0, 3)

  const header =
    notes.overview?.text || notes.keyTakeaways.length > 0
      ? { overview: notes.overview?.text ?? '', takeaways: notes.keyTakeaways }
      : null

  const saveItem = (itemId: string, text: string): void => {
    onWrite?.(mapNotesItems(notes, itemId, (item) => markEdited(item, text)))
  }
  const deleteItem = (itemId: string): void => {
    onWrite?.(mapNotesItems(notes, itemId, () => null))
  }
  const addKeyPoint = (section: NoteSection): void => {
    onWrite?.({
      ...notesContent(notes),
      sections: notes.sections.map((current) =>
        current.id === section.id
          ? {
              ...current,
              keyPoints: [...current.keyPoints, createUserItem('New note', current.title)]
            }
          : current
      )
    })
  }
  const addNextStep = (): void => {
    onWrite?.({
      ...notesContent(notes),
      nextSteps: [...notes.nextSteps, createUserItem('New next step')]
    })
  }
  const addSection = (): void => {
    const section: NoteSection = {
      id: `user-section:${crypto.randomUUID()}`,
      title: 'New topic',
      summary: null,
      keyPoints: [createUserItem('New note', 'New topic')],
      supportingDetails: []
    }
    onWrite?.({ ...notesContent(notes), sections: [...notes.sections, section] })
  }
  const saveSectionTitle = (sectionId: string, title: string): void => {
    onWrite?.({
      ...notesContent(notes),
      sections: notes.sections.map((section) =>
        section.id === sectionId ? { ...section, title } : section
      )
    })
  }
  const saveOverview = (text: string): void => {
    if (!notes.overview) return
    onWrite?.({
      ...notesContent(notes),
      overview: {
        ...notes.overview,
        text,
        provenance: notes.overview.provenance === 'user-created' ? 'user-created' : 'user-edited'
      }
    })
  }

  const itemEdit = onWrite
    ? { onSave: saveItem, onDelete: deleteItem }
    : { onSave: undefined, onDelete: undefined }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex rounded-lg border border-border bg-bg-card p-0.5">
          {(['option-1', 'option-2'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setOption(value)
                window.localStorage.setItem('autodoc.notesV2Option', value)
              }}
              className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold ${
                option === value ? 'bg-ink text-white' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {value === 'option-1' ? 'Option 1' : 'Option 2'}
            </button>
          ))}
        </div>
        {openSteps.length > 0 ? (
          <button
            type="button"
            className="text-[11.5px] font-semibold text-sage hover:text-sage-dark"
            onClick={() => document.getElementById('notes-next-steps')?.scrollIntoView({ behavior: 'smooth' })}
          >
            {openSteps.length} open
            {ownerPreview.length > 0 ? ` · ${ownerPreview.join(' · ')}` : ''}
          </button>
        ) : null}
      </div>

      {option === 'option-2' && header ? (
        <div className="rounded-xl border border-border bg-bg-card px-4 py-3">
          {header.overview ? (
            <InlineEdit
              value={header.overview}
              onSave={onWrite ? saveOverview : undefined}
              className="text-[13px] leading-relaxed text-ink-secondary"
              as="p"
            />
          ) : null}
          {header.takeaways.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {header.takeaways.map((item) => (
                <span
                  key={item.id}
                  className="group inline-flex items-center gap-1 rounded-full border border-border bg-bg-accent px-2 py-0.5 text-[11.5px] text-ink-secondary"
                >
                  <InlineEdit
                    value={item.text}
                    onSave={onWrite ? (text) => saveItem(item.id, text) : undefined}
                    className="text-[11.5px] text-ink-secondary"
                  />
                  {onWrite ? (
                    <button
                      type="button"
                      aria-label="Delete note"
                      onClick={() => deleteItem(item.id)}
                      className="text-[11px] text-ink-faint hover:text-clay"
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {option === 'option-2' && (notes.nextSteps.length > 0 || onWrite) ? (
        <div
          id="notes-next-steps"
          className="rounded-xl border border-sage/20 bg-sage-light/40 px-4 py-3"
        >
          <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-sage-dark">
            Next Steps
          </div>
          {notes.nextSteps.map((item) => (
            <NextStepRow
              key={item.id}
              item={item}
              meetingSpan={meetingSpan}
              onSeek={onSeek}
              onToggle={onToggleNextStep}
              {...itemEdit}
            />
          ))}
          {onWrite ? (
            <button
              type="button"
              className="mt-1 text-[11px] font-semibold text-ink-faint hover:text-sage"
              onClick={addNextStep}
            >
              + Add
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={option === 'option-1' ? 'mx-auto w-full max-w-[560px] py-2' : 'flex flex-col gap-5'}>
        {option === 'option-1' ? (
          <h2
            className="mb-4 text-[28px] font-normal tracking-tight text-ink"
            style={{ fontFamily: 'Instrument Serif, Georgia, serif' }}
          >
            {title?.trim() || 'Notes'}
          </h2>
        ) : null}
        {notes.sections.map((section) => {
          const extra = section.supportingDetails
          const open = expanded[section.id] === true
          return (
            <section key={section.id} className="mb-6">
              <InlineEdit
                value={section.title}
                onSave={onWrite ? (next) => saveSectionTitle(section.id, next) : undefined}
                className={
                  option === 'option-1'
                    ? 'mb-2 text-[18px] font-normal text-ink'
                    : 'mb-2 text-[15px] font-semibold text-ink'
                }
                style={
                  option === 'option-1'
                    ? { fontFamily: 'Instrument Serif, Georgia, serif' }
                    : undefined
                }
                as="h3"
              />
              {section.keyPoints.map((item) => (
                <Bullet
                  key={item.id}
                  item={item}
                  option={option}
                  meetingSpan={meetingSpan}
                  onSeek={onSeek}
                  {...itemEdit}
                />
              ))}
              {extra.length > 0 ? (
                <div className={option === 'option-1' ? 'pl-[64px]' : ''}>
                  {open
                    ? extra.map((item) => (
                        <Bullet
                          key={item.id}
                          item={item}
                          option={option}
                          meetingSpan={meetingSpan}
                          onSeek={onSeek}
                          {...itemEdit}
                        />
                      ))
                    : (
                      <button
                        type="button"
                        className="mt-1 text-[11.5px] font-semibold text-ink-muted hover:text-ink"
                        onClick={() => setExpanded((current) => ({ ...current, [section.id]: true }))}
                      >
                        {extra.length} more
                      </button>
                    )}
                </div>
              ) : null}
              {onWrite ? (
                <button
                  type="button"
                  className={`mt-1 text-[11px] font-semibold text-ink-faint hover:text-sage ${option === 'option-1' ? 'pl-[64px]' : ''}`}
                  onClick={() => addKeyPoint(section)}
                >
                  + Add
                </button>
              ) : null}
            </section>
          )
        })}
        {onWrite ? (
          <button
            type="button"
            className="text-[11px] font-semibold text-ink-faint hover:text-sage"
            onClick={addSection}
          >
            + Add topic
          </button>
        ) : null}
      </div>

      {option === 'option-1' && (notes.nextSteps.length > 0 || onWrite) ? (
        <div id="notes-next-steps" className="mx-auto w-full max-w-[560px] border-t border-border pt-4">
          <h3
            className="mb-2 text-[18px] font-normal text-ink"
            style={{ fontFamily: 'Instrument Serif, Georgia, serif' }}
          >
            Next Steps
          </h3>
          {notes.nextSteps.map((item) => (
            <NextStepRow
              key={item.id}
              item={item}
              meetingSpan={meetingSpan}
              onSeek={onSeek}
              onToggle={onToggleNextStep}
              {...itemEdit}
            />
          ))}
          {onWrite ? (
            <button
              type="button"
              className="mt-1 text-[11px] font-semibold text-ink-faint hover:text-sage"
              onClick={addNextStep}
            >
              + Add
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function useMeetingSpan(durationSeconds: number | null | undefined): NoteSourceRange[] {
  return useMemo(
    () => [{ startMs: 0, endMs: Math.max(0, Math.round((durationSeconds ?? 0) * 1000)) }],
    [durationSeconds]
  )
}
