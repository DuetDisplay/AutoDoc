import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type {
  MeetingNotesContent,
  MeetingNotesV2,
  NoteItem,
  NoteSection,
  NoteSourceRange
} from '../../../shared/types'
import { fallbackMeetingOverviewFromNotes } from '../../../shared/notes-overview-text'
import { displayNoteSectionHierarchy } from '../../../shared/notes-section-display'
import { isMeetingSpanOnly } from '../../../shared/notes-timestamps'
import { notesUseLosslessPresentation } from '../../../shared/notes-lossless-ids'
import {
  displayTopicLabel,
  isNeedsReviewTopic,
  toCustomerFacingNotes
} from '../../../shared/notes-presentation'
import { isWindowsRenderer } from '../services/microphone-access'
import { renderNoteMarkup } from './NoteMarkup'

type NotesOption = 'option-1' | 'option-2'

function optionHeadingClass(option: NotesOption, kind: 'section' | 'kicker'): string {
  if (option === 'option-1') {
    return kind === 'kicker'
      ? 'mb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-ink-muted'
      : 'mb-1 text-[13px] font-semibold text-ink'
  }
  return 'mb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-ink-muted'
}

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

function meetingSummary(
  notes: MeetingNotesV2,
  title: string | undefined,
  useLosslessPresentation: boolean
): string {
  const overview = notes.overview?.text.trim()
  if (overview) return overview
  if (!useLosslessPresentation) return fallbackMeetingOverviewFromNotes(notes.sections, title)
  return fallbackMeetingOverviewFromNotes(
    [
      ...notes.sections,
      {
        title: '',
        keyPoints: [...notes.decisions, ...notes.nextSteps]
      }
    ],
    title
  )
}

function RemoveButton({
  label,
  testId,
  onClick
}: {
  label: string
  testId?: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className="shrink-0 text-[11px] font-semibold text-transparent group-hover:text-clay hover:underline"
    >
      Remove
    </button>
  )
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

function markEdited(item: NoteItem, text: string, clearDistinctTitle: boolean): NoteItem {
  const sameTitle = Boolean(item.title?.trim()) && item.title?.trim() === item.text.trim()
  return {
    ...item,
    text,
    title: sameTitle ? text : clearDistinctTitle ? null : item.title,
    provenance: item.provenance === 'user-created' ? 'user-created' : 'user-edited'
  }
}

function markTitleEdited(item: NoteItem, title: string): NoteItem {
  return {
    ...item,
    title,
    provenance: item.provenance === 'user-created' ? 'user-created' : 'user-edited'
  }
}

function markOwnerEdited(item: NoteItem, owner: string | null): NoteItem {
  return {
    ...item,
    owner,
    provenance: item.provenance === 'user-created' ? 'user-created' : 'user-edited'
  }
}

function mapItems(
  items: NoteItem[],
  itemId: string,
  map: (item: NoteItem) => NoteItem | null
): NoteItem[] {
  return items
    .map((item) => (item.id === itemId ? map(item) : item))
    .filter((item): item is NoteItem => item != null)
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
        {renderNoteMarkup(value)}
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
    <Tag
      className={`${className ?? ''} cursor-text`}
      style={style}
      onClick={() => setEditing(true)}
    >
      {renderNoteMarkup(value)}
    </Tag>
  )
}

function OwnerEdit({
  owner,
  onSave
}: {
  owner: string | null
  onSave?: (next: string | null) => void
}): ReactElement | null {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(owner ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(owner ?? '')
  }, [owner])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  if (!onSave) {
    return owner ? <span className="ml-1.5 text-[11.5px] text-ink-muted">({owner})</span> : null
  }

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim() || null
    if (next !== (owner?.trim() || null)) onSave(next)
    else setDraft(owner ?? '')
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Owner"
        placeholder="Owner"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            inputRef.current?.blur()
          }
          if (event.key === 'Escape') {
            setDraft(owner ?? '')
            setEditing(false)
          }
        }}
        className="ml-1.5 w-[8rem] bg-transparent text-[11.5px] text-ink-muted outline-none"
      />
    )
  }

  if (!owner) {
    return (
      <button
        type="button"
        aria-label="Add owner"
        onClick={() => setEditing(true)}
        className="ml-1.5 text-[11px] font-semibold text-ink-faint hover:text-ink hover:underline"
      >
        + Owner
      </button>
    )
  }

  return (
    <span className="ml-1.5 inline-flex items-center gap-1">
      <button
        type="button"
        aria-label={`Owner: ${owner}`}
        onClick={() => setEditing(true)}
        className="text-[11.5px] text-ink-muted hover:underline"
      >
        ({owner})
      </button>
      <button
        type="button"
        aria-label="Remove owner"
        onClick={() => onSave(null)}
        className="text-[11px] font-semibold text-transparent group-hover:text-clay hover:underline"
      >
        Clear
      </button>
    </span>
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
  useLosslessPresentation,
  meetingSpan,
  onSeek,
  onSave,
  onSaveTitle,
  onSaveOwner,
  onDelete
}: {
  item: NoteItem
  useLosslessPresentation: boolean
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onSave?: (itemId: string, text: string) => void
  onSaveTitle?: (itemId: string, title: string) => void
  onSaveOwner?: (itemId: string, owner: string | null) => void
  onDelete?: (itemId: string) => void
}): ReactElement {
  const title = item.title?.trim() ?? ''
  const body = item.text.trim()
  const label = useLosslessPresentation ? body || title : title || body
  const hasDistinctTitle = Boolean(useLosslessPresentation && title && body && title !== body)
  const saveLabel =
    !useLosslessPresentation && title && onSaveTitle
      ? (text: string) => onSaveTitle(item.id, text)
      : onSave
        ? (text: string) => onSave(item.id, text)
        : undefined
  return (
    <div className="group flex items-start gap-2.5 py-1">
      <span aria-hidden className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-muted" />
      <div className="min-w-0 flex-1">
        <TopicLabel
          topic={
            useLosslessPresentation && isWindowsRenderer()
              ? displayTopicLabel(item.topic, { itemTitle: title })
              : null
          }
        />
        {hasDistinctTitle ? (
          <div className="text-[13px] font-medium leading-relaxed text-ink">
            {renderNoteMarkup(title)}
          </div>
        ) : null}
        <InlineEdit
          value={label}
          onSave={saveLabel}
          className={
            hasDistinctTitle
              ? 'text-[12.5px] leading-relaxed text-ink-secondary'
              : 'text-[13px] leading-relaxed text-ink'
          }
        />
        {useLosslessPresentation && (item.owner || item.deadline || onSaveOwner) ? (
          <div className="flex min-h-4 items-center">
            <OwnerEdit
              owner={item.owner}
              onSave={onSaveOwner ? (owner) => onSaveOwner(item.id, owner) : undefined}
            />
            {item.deadline ? (
              <span className="ml-1.5 text-[11.5px] text-ink-muted">Due: {item.deadline}</span>
            ) : null}
          </div>
        ) : (
          <OwnerEdit
            owner={item.owner}
            onSave={onSaveOwner ? (owner) => onSaveOwner(item.id, owner) : undefined}
          />
        )}
      </div>
      <JumpButton sources={item.sources} meetingSpan={meetingSpan} onSeek={onSeek} />
      {onDelete ? (
        <RemoveButton label="Delete next step" onClick={() => onDelete(item.id)} />
      ) : null}
    </div>
  )
}

function TopicLabel({ topic }: { topic: string | null | undefined }): ReactElement | null {
  const value = topic?.trim() ?? ''
  if (!value) return null
  return <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-ink-muted">{value}</div>
}

function Bullet({
  item,
  useLosslessPresentation,
  option,
  meetingSpan,
  onSeek,
  onSave,
  onDelete,
  deleteLabel = 'Delete note',
  indexOnly = false,
  sectionTitle = null
}: {
  item: NoteItem
  useLosslessPresentation: boolean
  option: NotesOption
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onSave?: (itemId: string, text: string) => void
  onDelete?: (itemId: string) => void
  deleteLabel?: string
  indexOnly?: boolean
  sectionTitle?: string | null
}): ReactElement {
  const parsed = stripAgreed(item.text)
  const title = item.title?.trim() ?? ''
  const hasDistinctTitle = Boolean(useLosslessPresentation && title && title !== parsed.text)
  const showBody = !indexOnly || !title
  const topic =
    useLosslessPresentation && isWindowsRenderer()
      ? displayTopicLabel(item.topic, { sectionTitle, itemTitle: title })
      : null
  const start = earliestStart(item.sources)
  const showTime = !isMeetingSpanOnly(item.sources, meetingSpan) && start != null
  const saveText = onSave
    ? (text: string) => onSave(item.id, parsed.agreed ? `Agreed: ${text}` : text)
    : undefined

  if (option === 'option-1') {
    return (
      <div
        className={`group grid grid-cols-[64px_minmax(0,1fr)_auto] gap-x-3 py-1.5 ${parsed.agreed ? 'border-l-2 border-sage pl-3' : ''}`}
      >
        <div className="pt-0.5 text-right">
          {showTime ? (
            <button
              type="button"
              onClick={() => onSeek(start)}
              className="text-[11px] tabular-nums text-ink-faint hover:text-ink"
              title={`Jump to ${formatClock(start)}`}
            >
              ▶ {formatClock(start)}
            </button>
          ) : null}
        </div>
        <div className="text-[13.5px] leading-relaxed text-ink">
          <TopicLabel topic={topic} />
          {hasDistinctTitle || (indexOnly && title) ? (
            <div className="font-medium text-ink">{renderNoteMarkup(title)}</div>
          ) : null}
          {parsed.agreed ? <span className="sr-only">Agreed: </span> : null}
          {showBody ? (
            <InlineEdit
              value={parsed.text}
              onSave={saveText}
              className={
                hasDistinctTitle
                  ? 'text-[12.5px] leading-relaxed text-ink-secondary'
                  : 'text-[13.5px] leading-relaxed text-ink'
              }
            />
          ) : null}
        </div>
        {onDelete ? (
          <RemoveButton
            label={deleteLabel}
            testId={`delete-${item.id}`}
            onClick={() => onDelete(item.id)}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className="group flex items-start justify-between gap-3 py-1">
      <div className="min-w-0 text-[13.5px] leading-relaxed text-ink">
        <TopicLabel topic={topic} />
        {hasDistinctTitle || (indexOnly && title) ? (
          <div className="font-medium text-ink">{renderNoteMarkup(title)}</div>
        ) : null}
        {parsed.agreed ? (
          <span className="mr-1.5 inline-flex items-center rounded-full bg-sage-light px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sage-dark">
            Agreed
          </span>
        ) : null}
        {showBody ? (
          <InlineEdit
            value={parsed.text}
            onSave={saveText}
            className={
              hasDistinctTitle
                ? 'text-[12.5px] leading-relaxed text-ink-secondary'
                : 'text-[13.5px] leading-relaxed text-ink'
            }
          />
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <JumpButton sources={item.sources} meetingSpan={meetingSpan} onSeek={onSeek} />
        {onDelete ? (
          <RemoveButton
            label={deleteLabel}
            testId={`delete-${item.id}`}
            onClick={() => onDelete(item.id)}
          />
        ) : null}
      </div>
    </div>
  )
}

function DecisionsSection({
  items,
  useLosslessPresentation,
  option,
  meetingSpan,
  onSeek,
  onSave,
  onDelete
}: {
  items: readonly NoteItem[]
  useLosslessPresentation: boolean
  option: NotesOption
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onSave?: (itemId: string, text: string) => void
  onDelete?: (itemId: string) => void
}): ReactElement | null {
  if (items.length === 0) return null

  const ready = isWindowsRenderer()
    ? items.filter((item) => !isNeedsReviewTopic(item.topic))
    : items
  if (ready.length === 0) return null
  const renderItems = (visible: readonly NoteItem[]): ReactElement[] =>
    visible.map((item) => (
      <Bullet
        key={item.id}
        item={item}
        useLosslessPresentation={useLosslessPresentation}
        option={option}
        meetingSpan={meetingSpan}
        onSeek={onSeek}
        onSave={onSave}
        onDelete={onDelete}
        deleteLabel="Delete decision"
      />
    ))

  if (option === 'option-2') {
    return (
      <section
        id="notes-decisions"
        className="rounded-xl border border-border bg-bg-card px-4 py-3"
      >
        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-ink-muted">
          Decisions
        </h3>
        {renderItems(ready)}
      </section>
    )
  }

  return (
    <section
      id="notes-decisions"
      className="mx-auto w-full max-w-[560px] border-t border-border pt-4"
    >
      <h3 className="mb-2 text-[17px] font-semibold text-ink">Decisions</h3>
      {renderItems(ready)}
    </section>
  )
}

function KeyTakeawaysSection({
  items,
  option,
  meetingSpan,
  onSeek,
  onSave,
  onDelete
}: {
  items: readonly NoteItem[]
  option: NotesOption
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onSave?: (itemId: string, text: string) => void
  onDelete?: (itemId: string) => void
}): ReactElement | null {
  if (items.length === 0) return null

  return (
    <section
      id="notes-key-takeaways"
      className={
        option === 'option-1'
          ? 'mx-auto w-full max-w-[560px] border-y border-border py-3'
          : 'rounded-xl border border-border bg-bg-card px-4 py-3'
      }
    >
      <h3
        className={
          option === 'option-1'
            ? 'mb-1 text-[13px] font-semibold text-ink'
            : 'mb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-ink-muted'
        }
      >
        Key Takeaways
      </h3>
      {items.map((item) => (
        <Bullet
          key={item.id}
          item={item}
          useLosslessPresentation
          option={option}
          meetingSpan={meetingSpan}
          onSeek={onSeek}
          onSave={onSave}
          onDelete={onDelete}
          deleteLabel="Delete key takeaway"
        />
      ))}
    </section>
  )
}

function SubBullet({
  item,
  useLosslessPresentation,
  option,
  meetingSpan,
  onSeek,
  onSave,
  onDelete
}: {
  item: NoteItem
  useLosslessPresentation: boolean
  option: NotesOption
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onSave?: (itemId: string, text: string) => void
  onDelete?: (itemId: string) => void
}): ReactElement {
  const parsed = stripAgreed(item.text)
  const title = item.title?.trim() ?? ''
  const hasDistinctTitle = Boolean(useLosslessPresentation && title && title !== parsed.text)
  const saveText = onSave
    ? (text: string) => onSave(item.id, parsed.agreed ? `Agreed: ${text}` : text)
    : undefined

  return (
    <div
      data-testid={`sub-${item.id}`}
      className={`group flex items-start gap-2 py-0.5 ${
        option === 'option-1' ? 'pl-[76px]' : 'pl-5'
      }`}
    >
      <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-secondary">
        {hasDistinctTitle ? (
          <div className="font-medium text-ink-secondary">{renderNoteMarkup(title)}</div>
        ) : null}
        {parsed.agreed ? (
          option === 'option-2' ? (
            <span className="mr-1.5 inline-flex items-center rounded-full bg-sage-light px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sage-dark">
              Agreed
            </span>
          ) : (
            <span className="sr-only">Agreed: </span>
          )
        ) : null}
        <InlineEdit
          value={parsed.text}
          onSave={saveText}
          className="text-[12.5px] leading-relaxed text-ink-secondary"
        />
      </div>
      <div className="flex items-center gap-1">
        <JumpButton sources={item.sources} meetingSpan={meetingSpan} onSeek={onSeek} />
        {onDelete ? (
          <RemoveButton
            label="Delete note"
            testId={`delete-${item.id}`}
            onClick={() => onDelete(item.id)}
          />
        ) : null}
      </div>
    </div>
  )
}

function BulletGroup({
  item,
  children,
  useLosslessPresentation,
  option,
  meetingSpan,
  onSeek,
  onSave,
  onDelete,
  sectionTitle = null
}: {
  item: NoteItem
  children: readonly NoteItem[]
  useLosslessPresentation: boolean
  option: NotesOption
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onSave?: (itemId: string, text: string) => void
  onDelete?: (itemId: string) => void
  sectionTitle?: string | null
}): ReactElement {
  return (
    <div>
      <Bullet
        item={item}
        useLosslessPresentation={useLosslessPresentation}
        option={option}
        meetingSpan={meetingSpan}
        onSeek={onSeek}
        onSave={onSave}
        onDelete={onDelete}
        sectionTitle={sectionTitle}
      />
      {children.length > 0 ? (
        <div className={option === 'option-1' ? '' : 'ml-0 border-l border-border'}>
          {children.map((child) => (
            <SubBullet
              key={child.id}
              item={child}
              useLosslessPresentation={useLosslessPresentation}
              option={option}
              meetingSpan={meetingSpan}
              onSeek={onSeek}
              onSave={onSave}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function NotesV2Document({
  notes,
  title,
  meetingSpan,
  onSeek,
  onWrite
}: {
  notes: MeetingNotesV2
  title?: string
  meetingSpan: readonly NoteSourceRange[]
  onSeek: (startMs: number) => void
  onWrite?: (content: MeetingNotesContent) => void
}): ReactElement {
  const [option, setOption] = useState<NotesOption>(() => {
    return window.localStorage.getItem('autodoc.notesV2Option') === 'option-2'
      ? 'option-2'
      : 'option-1'
  })
  const useLosslessPresentation = notesUseLosslessPresentation(notes)
  const windowsQuality = isWindowsRenderer()
  const documentNotes =
    useLosslessPresentation && windowsQuality ? toCustomerFacingNotes(notes, true) : notes
  const summary = meetingSummary(documentNotes, title, useLosslessPresentation)

  const saveItem = (itemId: string, text: string): void => {
    onWrite?.(
      mapNotesItems(notes, itemId, (item) => markEdited(item, text, useLosslessPresentation))
    )
  }
  const saveItemTitle = (itemId: string, itemTitle: string): void => {
    onWrite?.(mapNotesItems(notes, itemId, (item) => markTitleEdited(item, itemTitle)))
  }
  const saveOwner = (itemId: string, owner: string | null): void => {
    onWrite?.(mapNotesItems(notes, itemId, (item) => markOwnerEdited(item, owner)))
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
    ? { onSave: saveItem, onSaveOwner: saveOwner, onDelete: deleteItem }
    : { onSave: undefined, onSaveOwner: undefined, onDelete: undefined }
  const visibleNextSteps = windowsQuality
    ? documentNotes.nextSteps.filter((item) => !isNeedsReviewTopic(item.topic))
    : documentNotes.nextSteps
  const visibleSections = windowsQuality
    ? documentNotes.sections.filter((section) => !isNeedsReviewTopic(section.title))
    : documentNotes.sections
  const meetingTitle = title?.trim() ?? ''
  const optionColumn = option === 'option-1' ? 'mx-auto w-full max-w-[560px]' : ''

  return (
    <div className="flex flex-col gap-3">
      <div className="flex rounded-lg border border-border bg-bg-card p-0.5 self-start">
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

      {meetingTitle ? (
        <header className={optionColumn}>
          <p className={optionHeadingClass(option, 'kicker')}>Recorded meeting</p>
          <h2
            className={
              option === 'option-1'
                ? 'text-[22px] font-semibold tracking-tight text-ink'
                : 'text-[18px] font-semibold tracking-tight text-ink'
            }
          >
            {meetingTitle}
          </h2>
        </header>
      ) : null}

      {summary ? (
        <section
          aria-labelledby="notes-summary"
          className={
            option === 'option-1'
              ? `${optionColumn} pb-2`
              : 'rounded-xl border border-border bg-bg-card px-4 py-3'
          }
        >
          <h3 id="notes-summary" className={optionHeadingClass(option, 'section')}>
            Summary
          </h3>
          <InlineEdit
            value={summary}
            onSave={notes.overview && onWrite ? saveOverview : undefined}
            className="text-[13.5px] leading-relaxed text-ink-secondary"
            as="p"
          />
        </section>
      ) : null}

      {useLosslessPresentation ? (
        <KeyTakeawaysSection
          items={documentNotes.keyTakeaways}
          option={option}
          meetingSpan={meetingSpan}
          onSeek={onSeek}
          onSave={itemEdit.onSave}
          onDelete={itemEdit.onDelete}
        />
      ) : null}

      {useLosslessPresentation && option === 'option-2' ? (
        <DecisionsSection
          items={documentNotes.decisions}
          useLosslessPresentation={useLosslessPresentation}
          option={option}
          meetingSpan={meetingSpan}
          onSeek={onSeek}
          onSave={itemEdit.onSave}
          onDelete={itemEdit.onDelete}
        />
      ) : null}

      {option === 'option-2' && (visibleNextSteps.length > 0 || onWrite) ? (
        <div
          id="notes-next-steps"
          className="rounded-xl border border-sage/20 bg-sage-light/40 px-4 py-3"
        >
          <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-sage-dark">
            Next Steps
          </div>
          {visibleNextSteps.map((item) => (
              <NextStepRow
                key={item.id}
                item={item}
                useLosslessPresentation={useLosslessPresentation}
                meetingSpan={meetingSpan}
                onSeek={onSeek}
                onSaveTitle={onWrite ? saveItemTitle : undefined}
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

      <div
        className={
          option === 'option-1' ? 'mx-auto w-full max-w-[560px] py-2' : 'flex flex-col gap-5'
        }
      >
        {visibleSections.map((section) => {
          const hierarchy = displayNoteSectionHierarchy(
            section,
            isWindowsRenderer() && !useLosslessPresentation
          )
          const extra = hierarchy.supportingDetails
          const lastParentIndex = hierarchy.keyPoints.length - 1
          return (
            <section key={section.id} className="mb-6">
              <InlineEdit
                value={section.title}
                onSave={onWrite ? (next) => saveSectionTitle(section.id, next) : undefined}
                className={
                  option === 'option-1'
                    ? 'mb-2 text-[17px] font-semibold text-ink'
                    : 'mb-2 text-[18px] font-semibold tracking-tight text-ink'
                }
                as="h3"
              />
              {hierarchy.keyPoints.map((item, index) => (
                <BulletGroup
                  key={item.id}
                  item={item}
                  children={index === lastParentIndex ? extra : []}
                  useLosslessPresentation={useLosslessPresentation}
                  option={option}
                  meetingSpan={meetingSpan}
                  onSeek={onSeek}
                  sectionTitle={section.title}
                  {...itemEdit}
                />
              ))}
              {hierarchy.keyPoints.length === 0
                ? extra.map((item) => (
                    <Bullet
                      key={item.id}
                      item={item}
                      useLosslessPresentation={useLosslessPresentation}
                      option={option}
                      meetingSpan={meetingSpan}
                      onSeek={onSeek}
                      sectionTitle={section.title}
                      {...itemEdit}
                    />
                  ))
                : null}
              {onWrite ? (
                <button
                  type="button"
                  className={`mt-1 text-[11px] font-semibold text-ink-faint hover:text-sage ${option === 'option-1' ? 'pl-[76px]' : ''}`}
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

      {useLosslessPresentation && option === 'option-1' ? (
        <DecisionsSection
          items={documentNotes.decisions}
          useLosslessPresentation={useLosslessPresentation}
          option={option}
          meetingSpan={meetingSpan}
          onSeek={onSeek}
          onSave={itemEdit.onSave}
          onDelete={itemEdit.onDelete}
        />
      ) : null}

      {option === 'option-1' && (visibleNextSteps.length > 0 || onWrite) ? (
        <div
          id="notes-next-steps"
          className="mx-auto w-full max-w-[560px] border-t border-border pt-4"
        >
          <h3 className="mb-2 text-[17px] font-semibold text-ink">Next Steps</h3>
          {visibleNextSteps.map((item) => (
              <NextStepRow
                key={item.id}
                item={item}
                useLosslessPresentation={useLosslessPresentation}
                meetingSpan={meetingSpan}
                onSeek={onSeek}
                onSaveTitle={onWrite ? saveItemTitle : undefined}
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
