# Media capture checklist

These assets are referenced (currently commented out) in the root `README.md`.
Capture them, drop them in the indicated paths, then uncomment the matching
lines in `README.md`.

## Hero demo — highest priority

- **Path:** `docs/assets/demo.gif` (or `docs/assets/demo.mp4` + poster)
- **Length:** 20–40 seconds, looping.
- **Story to show (in order):**
  1. A meeting starts → AutoDoc's detection notification appears → click **Start AI Notes**.
  2. Recording indicator in the menu bar.
  3. Meeting ends → transcript appears with **speaker colors**.
  4. AI notes populate by category (Decisions / Action Items / …).
  5. Quick **Ask AI** question with a grounded answer.
- **Tips:** record at 2x display scale, then downscale; keep the cursor visible;
  use a real (non-sensitive) sample meeting.

## Feature screenshots

Save as PNG under `docs/assets/screenshots/`:

| File | Shot |
|------|------|
| `detection.png` | The floating "Meeting detected — Start AI Notes?" overlay. |
| `transcript.png` | Meeting detail → Transcript tab, showing speaker-colored, timestamped lines. |
| `notes.png` | Meeting detail → Notes tab, segments grouped by category. |
| `ask-ai.png` | Ask AI page mid-conversation with a cited answer. |

## Logo

`docs/assets/logo.png` already exists (rasterized from `resources/icon.svg`).
Regenerate at a larger size if needed:

```bash
node -e "require('sharp')('resources/icon.svg').resize(512,512).png().toFile('docs/assets/logo.png')"
```
