# Segment Video Jump — Design Spec

## Goal

Allow users to jump to the video/audio timestamp corresponding to an AI note (segment) in the Notes tab. Minimal UX — a hover-only play button with timestamp.

## Current State

- **Segments** have `sourceStartMs` and `sourceEndMs` fields in the `Segment` type (`shared/types.ts`), but they're hardcoded to `0` during LLM generation and manual creation.
- **Transcripts** have accurate millisecond timestamps from whisper.cpp (`startMs`/`endMs` on each `Transcript` entry).
- **Seeking** already works in the Transcript tab via `handleSeek()` in `MeetingDetail.tsx`, which sets `mediaRef.current.currentTime` and calls `play()`.
- **Media player** (video/audio element) is only rendered in the Transcript tab — `mediaRef.current` is `null` when on the Notes tab.
- **Transcript formatting** happens in `segmentation.ts:137` where transcripts are joined into a string: `[${t.speaker}] ${t.text}`. This string is passed to `llmProvider.summarize()`.

## Approach

Pass transcript timestamps through to the LLM prompt so it can associate each segment with its source timestamp range. Display a hover-only seek control on each note card that switches to the Transcript tab and seeks.

## Backend Changes

### Transcript formatting (`src/main/services/segmentation.ts`)

The transcript string is assembled in `segmentation.ts:137`. Change the format to include timestamps:

```
[00:00:12] [Speaker 1] Let's go over the sprint goals
[00:00:45] [Speaker 2] I think we should prioritize the auth work
```

The timestamp is derived from each `Transcript` entry's `startMs` field, formatted as `MM:SS` or `HH:MM:SS`.

### LLM Prompt and parsing (`src/main/services/llm.ts`)

**`SYSTEM_PROMPT`:** Update the JSON template to include `sourceStartMs` and `sourceEndMs` (integers, milliseconds) on each segment:

```json
{
  "decisions": [{ "topic": "broad theme", "title": "clear summary", "content": "full detail", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  ...
}
```

Add an instruction: "For each item, set `sourceStartMs` and `sourceEndMs` to the approximate start and end timestamps in milliseconds from the transcript timestamps."

**`RawSegment` interface:** Add optional fields:
```typescript
sourceStartMs?: number
sourceEndMs?: number
```

**Parsing (around line 280):** Read the fields from the LLM response, falling back to `0`:
```typescript
sourceStartMs: raw.sourceStartMs ?? 0,
sourceEndMs: raw.sourceEndMs ?? 0,
```

### Files modified

- `src/main/services/segmentation.ts` — timestamp-prefixed transcript formatting
- `src/main/services/llm.ts` — prompt update, `RawSegment` extension, parse timestamps

## Frontend Changes

### Hover Timestamp on Note Cards (`src/renderer/src/pages/MeetingDetail.tsx`)

**Interaction:** When a note card is hovered and the segment has a nonzero `sourceStartMs`, fade in a small `▶ 12:34` button. The button is positioned next to the existing delete (`×`) button which also appears on hover — both sit in the top-right area of the card in a row.

**On click:** Switch `activeTab` to `'transcript'` and call `handleSeek(segment.sourceStartMs)`. Since the media player is only rendered in the Transcript tab, switching tabs first ensures `mediaRef` gets attached to the DOM. Use a short `setTimeout` (or `requestAnimationFrame`) after the tab switch to allow React to render the media element before seeking.

**Visibility:** Only render the button when:
- Media exists (`hasVideo || hasAudio`)
- `segment.sourceStartMs > 0`

**Styling:** Match the existing delete button pattern — `opacity-0 group-hover:opacity-100` with a transition. Use subtle `text-ink-faint hover:text-ink` styling.

### Files modified

- `src/renderer/src/pages/MeetingDetail.tsx` — add hover seek control to segment rendering, tab-switch-then-seek logic

## What Doesn't Change

- `Segment` type in `shared/types.ts` — `sourceStartMs`/`sourceEndMs` fields already exist
- Segment storage/loading in `segmentation.ts` — already persists these fields
- IPC layer — no new channels needed

## Edge Cases

- **No media:** Don't show the hover control.
- **Timestamp is 0:** Don't show the hover control (LLM didn't return a timestamp or it's a manually-added note).
- **Existing segments:** Won't have timestamps until re-segmented. No backfill needed.
- **LLM doesn't follow instruction:** Fall back to 0 — no hover control shown, no regression.
- **Tab switch timing:** Use `requestAnimationFrame` after setting `activeTab` to ensure media element is in DOM before seeking.
