# A favor for future you — 16-second cut

The same approved direction with half the running time. Original 32-second source and export remain available.

- 0–3s: “I’ll remember.” / “Which version?”
- 3–6s: Actual note, then the genuine timestamp click at approximately 6s.
- 6–8.3s: The selected version and its context are shown immediately.
- 8.3–12s: Pull back for “Right. That one.” / “Thanks, past me.”
- 12–16s: “A favor for future you.” and getautodoc.com, with the URL visible by 12.85s.

Native footage is a continuous nine-second excerpt from 27.7814s in the original capture. Playback stays at normal speed. This cut ends before the recorded meeting reaches its end, removing the old stopped-player hold. It uses real Windows AutoDoc interaction with the original fictional meeting fixture.

The muted story, typography, colors, and sound accents are retained. The sound accents are retimed to the shorter sequence. The small opening footer is removed because the shorter shot did not give it enough reading time.

## Rebuild

```powershell
node make-short-cut.cjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/@remotion/cli/remotion-cli.js render FutureYouShort autodoc-future-you-short.mp4 --concurrency=2 --crf=16
node check-short.cjs
```

`src/Short.tsx` is independently editable; running `make-short-cut.cjs` regenerates it from the preserved original and the explicit timing substitutions. Stream metadata, sampled frames, and review notes are in `qa-short/`.
