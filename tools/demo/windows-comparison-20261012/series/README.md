# Three AutoDoc short demos

New examples 2, 3, and 5 following the approved “A favor for future you” direction. These retain the cream, ink, and sage palette, conversational punchlines, simple sound accents, and short runtimes. The approved first film remains unchanged.

| Film | Runtime | Genuine replay appears | Final card |
|---|---:|---:|---:|
| I remember none of the clicks | 16.5s | 5.5s | 12.7s |
| Change this section. Very helpful. | 15.5s | 5.2s | 11.9s |
| Can you scroll back up? | 14s | 5.2s | 10.5s |

## Provenance

`make-fixtures.cjs` creates three original fictional meeting recordings: a workspace notification walkthrough, a highlighted opening paragraph, and a scrolling launch checklist. Their UI belongs to fictional Fieldnotes meeting material, not to AutoDoc itself. The clips and representative SVGs are in `assets/`.

Fictional transcript and note fixtures are seeded in an isolated AutoDoc profile. This demonstrates reviewing notes and replaying a recorded moment; it does not demonstrate live transcription or AI note generation. No user meeting, account, external music, paid API, or third-party voice is used.

Each timestamp is clicked through the native AutoDoc UI using Computer Use, and the real window is captured by OpenScreen/WGC. Actual inputs and capture logs are in `qa/`; raw native captures are in `assets/`. No native UI is reconstructed for the film, and no playback speed changes are applied. `prepare-captures.cjs` detects the real transition in the captured pixels and trims idle lead-in to align each reveal. The manifest records timing and hashes.

Opening bubbles, reaction text, and captions are editorial graphics outside AutoDoc. The workspace steps and document edits shown inside replay belong to the original fictional meeting. The scrolling skit demonstrates replaying a moment on your own time, without claiming AutoDoc automatically scrolls another app.

## Editable project

`Films.tsx` contains the three compositions, registered from `../future-you/src/Root.tsx`. They reuse the existing pinned Remotion 4.0.535 project and installed dependencies. A local ignored junction at `series/node_modules` resolves those shared dependencies for the source file. For a fresh checkout, run `npm ci` in `future-you`, then create a directory junction to that absolute `node_modules` path.

Prepared native clips and original sound tracks are in `../future-you/public/series/`. To recapture, generate the fixtures and launch `launch-demo.cjs`, then record the actual native interactions. `make-fixtures.cjs` also launches the isolated app. Regenerating fixtures does not reproduce the native inputs by itself.

From `future-you`:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/@remotion/cli/remotion-cli.js render RememberTheClicks ../series/autodoc-clicks.mp4 --concurrency=2 --crf=16
node node_modules/@remotion/cli/remotion-cli.js render ChangeThisSection ../series/autodoc-section.mp4 --concurrency=2 --crf=16
node node_modules/@remotion/cli/remotion-cli.js render ScrollBackUp ../series/autodoc-scroll.mp4 --concurrency=2 --crf=16
```

From `series`, `node check-films.cjs` performs full decode and black-frame checks, checks export metadata, and creates contact sheets. FFmpeg/ffprobe use the existing local comparison toolchain under `../research/bin`. Renderer licensing is documented in `../LICENSES.md`.

Local gallery: `http://127.0.0.1:4180/series/index.html`, served by the existing comparison server. See `qa/review.md` for final review.
