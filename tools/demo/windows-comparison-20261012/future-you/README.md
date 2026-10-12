# A favor for future you

32-second AutoDoc launch film, 1920×1080 at 30 fps. Separate creative version; the original four-tool comparison is preserved.

## Story

- 0–4s: Yesterday you: “I’ll remember.” Today you: “Which version?”
- 4–8s: Real note, then the actual timestamp click at approximately 8 seconds.
- 8–18s: Continuous native playback, showing the selected version and its surrounding context.
- 18–25s: The app pulls back. “Right. That one.” / “Thanks, past me.”
- 25–32s: “A favor for future you.” / getautodoc.com.

The opening and payoff messages are editorial graphics outside the app. The source is the genuine native Windows AutoDoc capture from the original comparison, with its seeded fictional meeting. This demonstrates reviewing notes and reopening the recorded moment; it does not demonstrate live transcription or AI note generation. Playback runs at normal speed. The original in-meeting document has a partly clipped heading as captured; the selected Option B and player controls remain the proof points.

## Source and sound

`../assets/shared-native-capture.mp4`, trimmed from 26.7814 seconds for 21 seconds. No app UI reconstruction or fabricated click. After the meeting recording reaches its natural end, the real app remains on that final screen while the editorial payoff appears.

`public/sound-design.wav` contains original, locally synthesized soft tonal accents. No narration, third-party music, paid services, or uploads. The full story is readable with sound off.

## Rebuild

Dependencies reuse the original Remotion project's installed modules through an ignored local directory junction. On a fresh checkout use `npm ci` in this folder instead. Node 24 and Remotion 4.0.535 were used.

```powershell
node prepare-assets.cjs
node node_modules/@remotion/cli/remotion-cli.js studio --port=3003
node node_modules/@remotion/cli/remotion-cli.js render FutureYou autodoc-future-you.mp4 --concurrency=2 --crf=16
node check-render.cjs
```

Remotion licensing details are recorded in the parent comparison's `LICENSES.md`. The preview page is available from the existing local comparison server at `/future-you/index.html`.

## QA

Checks and visual review are recorded in `qa/review.md`. Full-resolution sampled frames, contact sheet, and stream metadata are in `qa/`.
