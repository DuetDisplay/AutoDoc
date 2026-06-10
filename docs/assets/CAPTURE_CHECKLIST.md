# Media capture checklist

Five assets total for the public README: **1 hero GIF + 4 screenshots**.
Nothing else is wired into `README.md` today.

After capturing, drop files at the paths below, then follow the **README wiring**
steps for each asset.

---

## Repo layout

```
docs/assets/
├── demo.gif                 ← hero (only motion asset)
├── logo.png                 ← already exists (README header)
└── screenshots/
    ├── detection.png
    ├── transcript.png
    ├── notes.png
    └── ask-ai.png
```

---

## README map

```
README.md
│
├── [Header]  logo.png ........................... docs/assets/logo.png  ✅ done
│
├── [Hero]    demo.gif ........................... docs/assets/demo.gif
│             (lines ~28–31, under tagline)
│
├── … text sections (no media) …
│
└── [Features in action]  2×2 screenshot grid ... docs/assets/screenshots/*.png
                          (lines ~100–106)
```

---

## 1. Hero GIF — `docs/assets/demo.gif`

| | |
|---|---|
| **README section** | Top of page, immediately under the tagline and badges |
| **README lines** | ~28–31 — replace the “Demo video coming soon” placeholder |
| **Format** | GIF (looping) preferred for GitHub; MP4 works on a website but GitHub README won’t embed MP4 inline |
| **Length** | 25–35 seconds, seamless loop |
| **Dimensions** | Capture at 2× Retina; export **~1280px wide** (keeps README load time reasonable) |

**Capture this story (in order):**

1. A meeting app is open → AutoDoc’s **“Meeting detected — Start AI Notes?”** overlay appears.
2. Click **Start AI Notes** → menu bar shows recording active.
3. Meeting ends (or stop recording) → open the recording.
4. **Transcript** tab: speaker-colored lines visible briefly.
5. **Notes** tab: categories populating (Decisions, Action Items, …).
6. **Ask AI**: one short question → grounded answer.

**Why:** Meetily leads with a hero demo too. Yours should feel **Mac-native** (overlay + menu bar) and end on **structured notes + Ask AI** — capabilities they often gate behind PRO.

**Wire into README** — in the hero block (~line 30), change:

```markdown
<!-- ![AutoDoc demo](docs/assets/demo.gif) -->
<em>📹 Demo video coming soon …</em>
```

to:

```markdown
![AutoDoc demo](docs/assets/demo.gif)
```

(and remove the “coming soon” line)

---

## 2. `docs/assets/screenshots/detection.png`

| | |
|---|---|
| **README section** | **Features in action** → top-left cell |
| **README lines** | ~102 — `detection.png` row |
| **Format** | PNG, ~1440px wide max |

**Capture:** Floating detection overlay on top of a realistic meeting window (Zoom / Meet / Teams). Show the pulsing green dot and **Start AI Notes** button. Blur anything sensitive.

**Caption in README:** “Automatic meeting detection”

**Why:** Auto-detect is a headline free feature; meetily treats it as premium/roadmap.

**Wire into README** — uncomment (~line 102):

```markdown
![Detection](docs/assets/screenshots/detection.png)
```

Remove `_screenshot coming soon_` from that cell.

---

## 3. `docs/assets/screenshots/transcript.png`

| | |
|---|---|
| **README section** | **Features in action** → top-right cell |
| **README lines** | ~102 — `transcript.png` row |
| **Format** | PNG |

**Capture:** Meeting detail → **Transcript** tab. Multiple speakers with sage/amber/slate colors, timestamps, enough lines to feel real. Bonus: “me” / “them” labels or a rename dropdown open.

**Caption in README:** “Speaker-colored transcript”

**Why:** Speaker diarization is visually distinctive and on-brand; meetily’s free tier doesn’t lead with this.

**Wire into README** — uncomment (~line 102):

```markdown
![Transcript](docs/assets/screenshots/transcript.png)
```

---

## 4. `docs/assets/screenshots/notes.png`

| | |
|---|---|
| **README section** | **Features in action** → bottom-left cell |
| **README lines** | ~106 — `notes.png` row |
| **Format** | PNG |

**Capture:** Meeting detail → **Notes** tab. Show **Decisions**, **Action Items**, **Information**, etc. with 2–3 items each. Include an action item with assignee/deadline if visible.

**Caption in README:** “AI notes by category”

**Why:** Meetily shows generic summaries; AutoDoc’s **structured categories** are a product identity choice — make the hierarchy obvious.

**Wire into README** — uncomment (~line 106):

```markdown
![Notes](docs/assets/screenshots/notes.png)
```

---

## 5. `docs/assets/screenshots/ask-ai.png`

| | |
|---|---|
| **README section** | **Features in action** → bottom-right cell |
| **README lines** | ~106 — `ask-ai.png` row |
| **Format** | PNG |

**Capture:** **Ask AI** page with a user question and a grounded answer (e.g. “What did we decide about the launch date?”). Show meeting reference/citation if the UI supports it.

**Caption in README:** “Ask AI across meetings”

**Why:** Chat-with-meetings is often premium elsewhere; this is a core free differentiator.

**Wire into README** — uncomment (~line 106):

```markdown
![Ask AI](docs/assets/screenshots/ask-ai.png)
```

---

## Capture guidelines (all assets)

- **Theme:** Light mode only (cream/sage brand palette).
- **Content:** Fake but realistic — e.g. “Weekly product sync”, speakers Alex / Jordan. No real customer data.
- **Mac context:** Include menu bar or overlay where relevant; reinforces Mac-native positioning.
- **Consistency:** Use the **same sample meeting** across all five assets so the README feels cohesive.
- **Compression:** PNGs ≤ ~400 KB each; hero GIF ≤ ~8 MB (use gifsicle or similar if needed).
- **No dev chrome:** Hide debug tools, personal emails, real calendar titles.

---

## Logo (already done)

| | |
|---|---|
| **Path** | `docs/assets/logo.png` |
| **README** | Header (~line 3): `<img src="docs/assets/logo.png" …>` |

Regenerate if needed:

```bash
node -e "require('sharp')('resources/icon.svg').resize(512,512).png().toFile('docs/assets/logo.png')"
```

---

## Optional later (not in README today)

Do **not** capture these unless you expand the README. Listed so you know what was intentionally left out:

| Asset | Would show | Why deferred |
|-------|------------|--------------|
| `calendar-auto-record.png` | Upcoming page + Off/Once/Series | Strong differentiator, but README grid is full |
| `menu-bar.png` | Tray menu with upcoming meetings | Mac-native identity shot; website material |
| `search.png` | Search results + deep link | Polish story; not required for launch parity |

---

## Quick checklist

- [ ] `docs/assets/demo.gif`
- [ ] `docs/assets/screenshots/detection.png`
- [ ] `docs/assets/screenshots/transcript.png`
- [ ] `docs/assets/screenshots/notes.png`
- [ ] `docs/assets/screenshots/ask-ai.png`
- [ ] Uncomment / swap placeholders in `README.md` (hero + 2×2 grid)
- [ ] Preview rendered README on GitHub before merging
