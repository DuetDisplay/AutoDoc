# Short-cut review — 2026-10-12

- 16.000 seconds, 1920×1080, 30 fps, 480 frames, H.264 with AAC. 2,068,165 bytes.
- Full video/audio decode passed. No black intervals detected with `blackdetect=d=0.05:pix_th=0.08`.
- TypeScript check passed.
- Inspected the sixteen sampled frames and contact sheet. Note and real timestamp are visible at 5.90s; actual recording and 0:06 playback position are visible at 6.15s.
- The large playback view ends at 8.3s, approximately 2.3s after the click. The app continues playing at normal speed during the shorter payoff. This cut contains none of the previous stopped-player hold.
- Opening, payoff, and CTA remain inside frame; URL appears by 12.85s and stays visible through the end.
- Sound accents were retimed to the new beat positions. Audio peak −19.6 dBFS; no clipping.
- Original 32-second export and composition were preserved. The main preview page now defaults to the 16-second cut and links to the previous cut.
