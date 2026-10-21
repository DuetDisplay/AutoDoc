# AutoDoc — real app rebuild

A silent 16-second widescreen direction prototype: **Click a note. Replay the moment.**

The note at **0:15** opens the iPad image from the recorded screen, inside the actual AutoDoc desktop app. The meeting notes and transcript are fictional demonstration content. The underlying screen video is a native browser recording of the Duet homepage. There is no voice track, music or sound effect.

- `autodoc-real-app-silent.mp4`: edited review cut, 1920×1080, 60 fps.
- `autodoc-native-raw.mp4`: full unedited native window capture, video stream copied from the original MOV.
- `PROVENANCE.json`: source and edit details.

Cinetic informed the creative brief and critique. The native capture uses ScreenCaptureKit; the edit uses FFmpeg. This prototype establishes the real-app direction before making tone and format variants.

## Reproduction

Source scripts are in `tools/demo/real-app-rebuild`:

1. Build the real app with `node node_modules/electron-vite/bin/electron-vite.js build`.
2. Bundle `seed.ts` with esbuild, then run `seed.cjs` to prepare the isolated temporary profile.
3. Launch `node_modules/.bin/electron tools/demo/real-app-rebuild/launch.cjs`.
4. Capture the native window using `capture/window-recorder.swift`, and click the note through the actual UI.
5. Generate the title cards with `make-ending.py`, then run `node tools/demo/real-app-rebuild/render.cjs`.

The render reads the committed `final/real-app-review/autodoc-native-raw.mp4` (the same video stream as take 4) and the bundled fonts. Run `make-ending.py` before `render.cjs` to generate its title cards. Python needs Pillow. FFmpeg is required. The raw browser source and the isolated profile remain local; `PROVENANCE.json` documents the meeting-video preparation.

For the latest ad, use `../real-app-ad/README.md`. These capture helpers are optional and macOS-specific; the latest Remotion edit renders independently from its committed footage.
