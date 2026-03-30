# Segment Video Jump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to click a hover-only play button on AI note cards to jump to the corresponding video/audio timestamp.

**Architecture:** Backend passes timestamps through transcript formatting to the LLM prompt, which returns `sourceStartMs`/`sourceEndMs` per segment. Frontend renders a hover play button that switches to the Transcript tab and seeks the media player.

**Tech Stack:** TypeScript, Electron (main + renderer), React, Tailwind CSS, Ollama LLM

---

### Task 1: Add timestamps to transcript formatting

**Files:**
- Modify: `src/main/services/segmentation.ts:137`

- [ ] **Step 1: Update transcript formatting to include timestamps**

Change line 137 from:

```typescript
const fullText = transcripts.map((t) => `[${t.speaker}] ${t.text}`).join('\n')
```

To:

```typescript
const fullText = transcripts
  .map((t) => {
    const totalSec = Math.floor(t.startMs / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    const ts = h > 0
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `[${ts}] [${t.speaker}] ${t.text}`
  })
  .join('\n')
```

This formats each transcript line as `[00:12] [Speaker 1] Let's go over the sprint goals`. The `chunkTranscript()` function splits on newlines so this format is safe.

- [ ] **Step 2: Verify the app builds**

Run: `cd /Users/rahuldewan/Documents/GitHub/AutoDoc-Local && npm run typecheck`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/segmentation.ts
git commit -m "feat(segmentation): add timestamps to transcript formatting for LLM"
```

---

### Task 2: Update LLM prompt and parsing for segment timestamps

**Files:**
- Modify: `src/main/services/llm.ts:54` (JSON template in SYSTEM_PROMPT)
- Modify: `src/main/services/llm.ts:68-74` (RawSegment interface)
- Modify: `src/main/services/llm.ts:280-281` (parsing fallback)

- [ ] **Step 1: Add timestamp instruction to SYSTEM_PROMPT**

In `llm.ts`, find the JSON template inside `SYSTEM_PROMPT` (lines 53-58). Add `sourceStartMs` and `sourceEndMs` to each category's example object. Also add an instruction paragraph.

Replace the JSON template block (lines 52-59):

```typescript
Respond with ONLY valid JSON (no markdown, no explanation):
{
  "decisions": [{ "topic": "broad theme", "title": "clear summary", "content": "full context with names and reasoning", "assignee": null, "deadline": null }],
  "action_items": [{ "topic": "broad theme", "title": "specific task", "content": "full detail of what needs to happen", "assignee": "person or null", "deadline": "deadline or null" }],
  "information": [{ "topic": "broad theme", "title": "what was shared", "content": "exact details, numbers, and context", "assignee": null, "deadline": null }],
  "discussion": [{ "topic": "broad theme", "title": "topic debated", "content": "positions taken, arguments made, outcome if any", "assignee": null, "deadline": null }],
  "status_updates": [{ "topic": "broad theme", "title": "what was reported", "content": "current state, blockers, next steps", "assignee": null, "deadline": null }]
}
```

With:

```typescript
TIMESTAMPS — The transcript includes timestamps like [00:12] or [01:05:30] at the start of each line. For each item, set "sourceStartMs" and "sourceEndMs" to the approximate start and end timestamps in milliseconds. Convert the timestamp format to milliseconds (e.g., [02:30] = 150000ms, [01:05:30] = 3930000ms). If unsure, use 0.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "decisions": [{ "topic": "broad theme", "title": "clear summary", "content": "full context with names and reasoning", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "action_items": [{ "topic": "broad theme", "title": "specific task", "content": "full detail of what needs to happen", "assignee": "person or null", "deadline": "deadline or null", "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "information": [{ "topic": "broad theme", "title": "what was shared", "content": "exact details, numbers, and context", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "discussion": [{ "topic": "broad theme", "title": "topic debated", "content": "positions taken, arguments made, outcome if any", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "status_updates": [{ "topic": "broad theme", "title": "what was reported", "content": "current state, blockers, next steps", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }]
}
```

- [ ] **Step 2: Add optional fields to RawSegment interface**

At `llm.ts:68-74`, update the `RawSegment` interface:

```typescript
interface RawSegment {
  topic?: string
  title?: string
  content?: string
  assignee?: string | null
  deadline?: string | null
  sourceStartMs?: number
  sourceEndMs?: number
}
```

- [ ] **Step 3: Read timestamp fields during parsing**

At `llm.ts:280-281`, replace:

```typescript
          sourceStartMs: 0,
          sourceEndMs: 0,
```

With:

```typescript
          sourceStartMs: typeof item.sourceStartMs === 'number' ? item.sourceStartMs : 0,
          sourceEndMs: typeof item.sourceEndMs === 'number' ? item.sourceEndMs : 0,
```

- [ ] **Step 4: Verify the app builds**

Run: `cd /Users/rahuldewan/Documents/GitHub/AutoDoc-Local && npm run typecheck`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/llm.ts
git commit -m "feat(llm): add sourceStartMs/sourceEndMs to prompt and parsing"
```

---

### Task 3: Add hover seek button to note cards

**Files:**
- Modify: `src/renderer/src/pages/MeetingDetail.tsx:473-486` (segment card rendering)
- Modify: `src/renderer/src/pages/MeetingDetail.tsx:137-142` (handleSeek — needs tab-switch logic)

- [ ] **Step 1: Add a `seekToSegment` handler that switches tab then seeks**

Near the existing `handleSeek` callback (around line 137), add a new callback below it:

```typescript
const seekToSegment = useCallback((ms: number) => {
  setActiveTab('transcript')
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = mediaRef.current
      if (!el) return
      el.currentTime = ms / 1000
      el.play()
    })
  })
}, [])
```

Double `requestAnimationFrame` ensures React has rendered the Transcript tab (which mounts the media element) before we try to seek. The first rAF fires after React commits the state update, the second fires after the browser paints the new DOM.

- [ ] **Step 2: Add a `formatTimestamp` helper**

Add this helper function inside the component, near the top (before the JSX return):

```typescript
const formatTimestamp = (ms: number): string => {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
```

- [ ] **Step 3: Add the hover play button next to the delete button**

In the segment card JSX at lines 480-486, the delete button sits inside a `<div className="flex items-start justify-between gap-2">`. Add a play button before the delete button, both wrapped in a flex row.

Replace lines 480-486:

```tsx
                                    <button
                                      onClick={() => deleteSegment(category, globalIndex)}
                                      className="shrink-0 opacity-0 group-hover:opacity-100 text-[11px] text-ink-faint hover:text-clay transition-all mt-0.5"
                                      title="Delete"
                                    >
                                      &times;
                                    </button>
```

With:

```tsx
                                    <div className="flex items-center gap-1 shrink-0">
                                      {(media?.hasVideo || media?.hasAudio) && item.sourceStartMs > 0 && (
                                        <button
                                          onClick={() => seekToSegment(item.sourceStartMs)}
                                          className="opacity-0 group-hover:opacity-100 text-[11px] text-ink-faint hover:text-ink transition-all mt-0.5"
                                          title={`Jump to ${formatTimestamp(item.sourceStartMs)}`}
                                        >
                                          ▶ {formatTimestamp(item.sourceStartMs)}
                                        </button>
                                      )}
                                      <button
                                        onClick={() => deleteSegment(category, globalIndex)}
                                        className="opacity-0 group-hover:opacity-100 text-[11px] text-ink-faint hover:text-clay transition-all mt-0.5"
                                        title="Delete"
                                      >
                                        &times;
                                      </button>
                                    </div>
```

The play button:
- Only renders when media exists AND `sourceStartMs > 0`
- Shows `▶ 2:30` format with the timestamp
- Uses `opacity-0 group-hover:opacity-100` matching the existing delete button pattern
- Uses `text-ink-faint hover:text-ink` for subtle styling (slightly different from delete's `hover:text-clay`)
- Calls `seekToSegment` which switches to Transcript tab, waits for render, then seeks

- [ ] **Step 4: Verify the app builds**

Run: `cd /Users/rahuldewan/Documents/GitHub/AutoDoc-Local && npm run typecheck`
Expected: No type errors.

- [ ] **Step 5: Manual test**

1. Open a meeting that has both a recording and AI notes
2. Hover over a note card — verify the `▶ timestamp` button appears alongside the `×` delete button
3. Click the play button — verify the app switches to the Transcript tab and the media starts playing at that timestamp
4. For notes without timestamps (sourceStartMs = 0), verify no play button appears
5. For meetings without media, verify no play button appears

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages/MeetingDetail.tsx
git commit -m "feat(ui): add hover seek button on AI note cards"
```
