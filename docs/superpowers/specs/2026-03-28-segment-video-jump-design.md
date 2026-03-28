# Segment Video Jump — Design Spec

## Goal

Allow users to jump to the video/audio timestamp corresponding to an AI note (segment) in the Notes tab. Minimal UX — a hover-only play button with timestamp.

## Current State

- **Segments** have `sourceStartMs` and `sourceEndMs` fields in the `Segment` type, but they're hardcoded to `0` during LLM generation (`llm.ts:280-281`) and manual creation (`MeetingDetail.tsx:218-219`).
- **Transcripts** have accurate millisecond timestamps from whisper.cpp.
- **Seeking** already works in the Transcript tab via `handleSeek()` in `MeetingDetail.tsx`, which sets `mediaRef.current.currentTime` and calls `play()`.

## Approach

Pass transcript timestamps through to the LLM prompt so it can associate each segment with its source timestamp range. Display a hover-only seek control on each note card.

## Backend Changes

### LLM Prompt (`src/main/services/llm.ts`)

**Transcript formatting:** When building the transcript text for the LLM, prepend each transcript entry's timestamp so the LLM can see when things were said:

```
[00:00:12] Let's go over the sprint goals
[00:00:45] I think we should prioritize the auth work
[00:01:23] Agreed, and we need to assign the API review
```

**Prompt update:** Add an instruction asking the LLM to include `sourceStartMs` and `sourceEndMs` in its JSON output for each segment, representing the approximate start and end of the source material in the transcript.

**Parsing:** When parsing the LLM response, read `sourceStartMs` and `sourceEndMs` from the JSON (falling back to `0` if absent, for backward compatibility with models that don't follow the instruction).

### Files modified

- `src/main/services/llm.ts` — transcript formatting and prompt changes, parse timestamps from response

## Frontend Changes

### Hover Timestamp on Note Cards (`src/renderer/src/pages/MeetingDetail.tsx`)

- When a note card is hovered and the segment has a nonzero `sourceStartMs`, fade in a small `▶ 12:34` button at the top-right corner of the card.
- Clicking the button calls `handleSeek(segment.sourceStartMs)` — same mechanism as the Transcript tab.
- Only render the button when media exists (`hasVideo || hasAudio`).
- Use CSS opacity transition for the fade-in/out.

### Files modified

- `src/renderer/src/pages/MeetingDetail.tsx` — add hover seek control to segment rendering

## What Doesn't Change

- `Segment` type in `shared/types.ts` — fields already exist
- Segment storage/loading in `segmentation.ts` — already persists these fields
- IPC layer — no new channels needed
- `handleSeek()` — already implemented

## Edge Cases

- **No media:** Don't show the hover control.
- **Timestamp is 0:** Don't show the hover control (LLM didn't return a timestamp or it's a manually-added note).
- **Existing segments:** Won't have timestamps until re-segmented. No backfill needed.
- **LLM doesn't follow instruction:** Fall back to 0 — no hover control shown, no regression.
