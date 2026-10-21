# AutoDoc — The moment, one click away

A 17-second advertisement built from actual AutoDoc desktop footage: a cursor clicks the real 0:15 timestamp, the note stays visible beside recorded playback, and the replay enlarges before the brand ending. Mock meeting notes/transcript are used. Camera moves, cursor emphasis and the connecting line are editorial layers. The film is silent.

## Continue on another machine

Use the public **DuetDisplay/AutoDoc** repository, branch **codex/autodoc-product-demos**. The finished MP4 is `final/real-app-ad-review/autodoc-moment-ad.mp4`.

Requirements: Node.js 22 or newer, npm, and FFmpeg on PATH with libx264 support. The edit project installs independently of the desktop app.

```sh
git fetch origin
git switch codex/autodoc-product-demos
git pull --ff-only
cd tools/demo/real-app-ad
npm ci
npx remotion browser ensure
npm run studio
```

If the local branch does not exist yet, use `git switch --track origin/codex/autodoc-product-demos`. Studio prints its local preview URL. Open that URL on the machine running Studio.

```sh
npm run check
npm run stills
npm run preview
npm run render
```

`preview` writes `out/preview.mp4` at 960×540/60 fps. `render` writes the master to `final/real-app-ad-review/autodoc-moment-ad.mp4` relative to the repository root. It renders 120 temporal samples per second, then uses FFmpeg to finish at 1920×1080/60 fps, H.264, BT.709. The two-sample blend smooths camera motion without fabricated UI. The renderer creates output directories automatically. `REMOTION_BROWSER` or `CHROMIUM_PATH` can override the automatically managed headless browser.

## Editing map

- `src/system.tsx`: shared timing constants, brand tokens, camera anchors and note aperture.
- `src/scenes/Product.tsx`: cursor travel/press, timestamp relay and native replay.
- `src/scenes/Ending.tsx`: brand lockup and ending.
- `public/native/notes.png`: exact native app frame held for reading.
- `public/native/replay.mp4`: actual native desktop-player capture used by the composition; committed, not a local-only dependency.
- `source/meeting-motion.webm`: the staged 32-second screen video played inside AutoDoc, cropped to exclude browser chrome.
- `final/real-app-ad-review/autodoc-native-motion-raw.mp4`: complete native app take, remuxed from MOV without re-encoding.
- `qa/`: export checks, declared source viewport updates, review notes and contact sheet.
- `PROVENANCE.json`: source attribution and editorial details.

The original browser MOV and temporary AutoDoc profile stay on the capture machine. They are not needed to edit or render this project. The source video, extracted native frame, native replay clip, fonts and lockfile needed for this edit are committed. Font licenses and the Cinetic MIT license are included.

The previous 16-second native cut is retained under `final/real-app-review`; the earlier product-demo films already on this branch remain in `tools/demo/windows-comparison-20261012`.

Cinetic workflow references are pinned to ecfa6605de1adb9345ce937724810dc32267d068. QA notes retain warnings from automated inspection; this is not a claim of flawless commercial finish or advertising effectiveness.
