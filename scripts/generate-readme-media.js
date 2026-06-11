#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { chromium } = require('@playwright/test')
const sharp = require('sharp')

const ROOT = path.resolve(__dirname, '..')
const ASSET_DIR = path.join(ROOT, 'docs', 'assets')
const SCREENSHOT_DIR = path.join(ASSET_DIR, 'screenshots')
const TMP_DIR = path.join(os.tmpdir(), `autodoc-readme-media-${process.pid}`)

const SCREENSHOT_VIEWPORT = { width: 1440, height: 900 }
const GIF_VIEWPORT = { width: 1120, height: 700 }

const MEETING_ID = 'weekly-product-sync'
const MEETING_DATE = new Date('2026-06-10T14:00:00Z').getTime()

const transcript = [
  {
    id: 't-1',
    meetingId: MEETING_ID,
    speaker: 'me',
    text: 'Let us use the June 28 release candidate as the date we plan around, assuming the privacy copy and updater smoke test both land this week.',
    startMs: 12_000,
    endMs: 27_000,
    confidence: 0.96
  },
  {
    id: 't-2',
    meetingId: MEETING_ID,
    speaker: 'speaker-jordan',
    text: 'That works. I want the README to show the local processing story first, then the detection and Ask AI flow so it feels clear for new users.',
    startMs: 34_000,
    endMs: 48_000,
    confidence: 0.94
  },
  {
    id: 't-3',
    meetingId: MEETING_ID,
    speaker: 'speaker-priya',
    text: 'I can own the launch checklist and make sure the screenshots use mocked meeting content only. No customer names, no real calendar data.',
    startMs: 64_000,
    endMs: 76_000,
    confidence: 0.95
  },
  {
    id: 't-4',
    meetingId: MEETING_ID,
    speaker: 'me',
    text: 'Decision is June 28 for the release candidate. We will call out Apple Silicon, local Whisper, local Ollama, and encryption at rest.',
    startMs: 91_000,
    endMs: 103_000,
    confidence: 0.97
  },
  {
    id: 't-5',
    meetingId: MEETING_ID,
    speaker: 'speaker-jordan',
    text: 'For the demo, let us end on one Ask AI answer that cites the product sync and explains the decision in plain language.',
    startMs: 128_000,
    endMs: 139_000,
    confidence: 0.93
  },
  {
    id: 't-6',
    meetingId: MEETING_ID,
    speaker: 'speaker-priya',
    text: 'I will verify the updater path tomorrow morning and post the result in the launch thread before design review.',
    startMs: 162_000,
    endMs: 171_000,
    confidence: 0.94
  },
  {
    id: 't-7',
    meetingId: MEETING_ID,
    speaker: 'me',
    text: 'Great. The capture generator should use the real renderer with mocked IPC data so future screenshots match the product.',
    startMs: 196_000,
    endMs: 207_000,
    confidence: 0.95
  }
]

const segments = {
  decisions: [
    {
      id: 'decision-1',
      meetingId: MEETING_ID,
      category: 'decision',
      topic: 'Launch plan',
      title: 'Release candidate date',
      content: 'Team agreed to plan the release candidate around June 28 if smoke tests pass.',
      assignee: null,
      deadline: null,
      sourceStartMs: 91_000,
      sourceEndMs: 103_000
    },
    {
      id: 'decision-2',
      meetingId: MEETING_ID,
      category: 'decision',
      topic: 'README media',
      title: 'Use one cohesive mocked meeting',
      content:
        'Detection, transcript, notes, and Ask AI should all use the same product sync story.',
      assignee: null,
      deadline: null,
      sourceStartMs: 196_000,
      sourceEndMs: 207_000
    }
  ],
  actionItems: [
    {
      id: 'action-1',
      meetingId: MEETING_ID,
      category: 'action_item',
      topic: 'Launch plan',
      title: 'Verify updater smoke test',
      content: 'Priya will run the private feed updater check by Thursday morning.',
      assignee: 'Priya',
      deadline: 'Thu',
      sourceStartMs: 162_000,
      sourceEndMs: 171_000
    },
    {
      id: 'action-2',
      meetingId: MEETING_ID,
      category: 'action_item',
      topic: 'README media',
      title: 'Review final capture set',
      content: 'Jordan will review the generated README media before the release branch.',
      assignee: 'Jordan',
      deadline: 'Fri',
      sourceStartMs: 128_000,
      sourceEndMs: 139_000
    }
  ],
  information: [
    {
      id: 'info-1',
      meetingId: MEETING_ID,
      category: 'information',
      topic: 'Positioning',
      title: 'Local AI story',
      content: 'README should lead with on-device Whisper, local Ollama, and encrypted storage.',
      assignee: null,
      deadline: null,
      sourceStartMs: 34_000,
      sourceEndMs: 48_000
    },
    {
      id: 'info-2',
      meetingId: MEETING_ID,
      category: 'information',
      topic: 'Positioning',
      title: 'Launch audience',
      content:
        'The first public pass is aimed at Mac users who want private meeting notes without a subscription.',
      assignee: null,
      deadline: null,
      sourceStartMs: 34_000,
      sourceEndMs: 48_000
    }
  ],
  discussion: [
    {
      id: 'discussion-1',
      meetingId: MEETING_ID,
      category: 'discussion',
      topic: 'Trust surfaces',
      title: 'Launch-readiness surfaces',
      content:
        'The team compared privacy copy, system requirements, and self-hosting instructions.',
      assignee: null,
      deadline: null,
      sourceStartMs: 12_000,
      sourceEndMs: 48_000
    },
    {
      id: 'discussion-2',
      meetingId: MEETING_ID,
      category: 'discussion',
      topic: 'Demo pacing',
      title: 'Hero GIF sequence',
      content:
        'The GIF should move from detection into transcript, structured notes, and one grounded answer.',
      assignee: null,
      deadline: null,
      sourceStartMs: 128_000,
      sourceEndMs: 139_000
    }
  ],
  statusUpdates: [
    {
      id: 'status-1',
      meetingId: MEETING_ID,
      category: 'status_update',
      topic: 'Capture work',
      title: 'Checklist ready',
      content:
        'Asset paths and README placement are ready; only mocked media needs to be generated.',
      assignee: null,
      deadline: null,
      sourceStartMs: 64_000,
      sourceEndMs: 76_000
    },
    {
      id: 'status-2',
      meetingId: MEETING_ID,
      category: 'status_update',
      topic: 'Capture work',
      title: 'Renderer harness',
      content: 'Captures now load the actual AutoDoc renderer with mocked IPC responses.',
      assignee: null,
      deadline: null,
      sourceStartMs: 196_000,
      sourceEndMs: 207_000
    }
  ]
}

const speakers = {
  me: { label: 'Alex' },
  'speaker-jordan': { label: 'Jordan' },
  'speaker-priya': { label: 'Priya' }
}

const askAiMessages = [
  {
    id: 'user-readme-capture',
    role: 'user',
    content: 'What did we decide about the release candidate?',
    status: 'complete'
  },
  {
    id: 'assistant-readme-capture',
    role: 'assistant',
    content:
      'The team decided to plan the release candidate around June 28, as long as the privacy copy and updater smoke test are finished this week. Priya owns the updater check, and Jordan will review the README media before the release branch.',
    status: 'complete'
  }
]

function json(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function buildMockScript() {
  return `
    (() => {
      const meetingId = ${json(MEETING_ID)};
      const meetingDate = ${json(MEETING_DATE)};
      const transcript = ${json(transcript)};
      const segments = ${json(segments)};
      const speakers = ${json(speakers)};
      const askAiMessages = ${json(askAiMessages)};
      const listeners = new Map();

      localStorage.setItem('autodoc-ask-ai-chat', JSON.stringify({
        state: { messages: askAiMessages, draftInput: '' },
        version: 0
      }));

      const isRecordingCapture = () => new URLSearchParams(window.location.search).get('recording') === '1';
      const recordingState = () => ({
        isRecording: isRecordingCapture(),
        meetingId: isRecordingCapture() ? meetingId : null,
        startedAt: isRecordingCapture() ? Date.now() - 42000 : null,
        sourceId: isRecordingCapture() ? 'mock-google-meet-window' : null,
        sourceName: isRecordingCapture() ? 'Weekly product sync' : null,
        recordingIntent: isRecordingCapture() ? 'manual' : null,
        trackedMeetingSourceId: isRecordingCapture() ? 'mock-google-meet-window' : null,
        trackedMeetingSourceName: isRecordingCapture() ? 'Weekly product sync' : null,
        trackedMeetingProviderId: isRecordingCapture() ? 'google-meet' : null
      });

      const handlers = {
        'prefs:get-onboarding-complete': () => true,
        'prefs:get-analytics-consent': () => false,
        'prefs:get-diagnostic-log-upload-consent': () => false,
        'prefs:get-low-spec-mac-processing-banner-dismissed': () => true,
        'prefs:set-analytics-consent': () => undefined,
        'prefs:set-diagnostic-log-upload-consent': () => undefined,
        'diagnostics:record-action': () => undefined,
        'diagnostics:clear-trail': () => undefined,
        'calendar:get-accounts': () => [{
          id: 'acct-google',
          provider: 'google',
          email: 'team@example.com',
          connectedAt: meetingDate - 86400000
        }],
        'calendar:get-events': () => [{
          id: 'evt-weekly-product-sync',
          externalId: 'evt-weekly-product-sync',
          accountId: 'acct-google',
          provider: 'google',
          recurringEventId: null,
          title: 'Weekly product sync',
          startTime: meetingDate,
          endTime: meetingDate + 2280000,
          attendees: ['alex@example.com', 'jordan@example.com', 'priya@example.com'],
          meetingUrl: 'https://meet.google.com/weekly-product-sync',
          autoRecord: 'off',
          syncedAt: meetingDate - 300000
        }],
        'calendar:sync': () => [],
        'recording:get-state': () => recordingState(),
        'recording:get-sources': () => [],
        'recording:list': () => [{
          meetingId,
          title: 'Weekly product sync',
          date: meetingDate,
          duration: 2280,
          hasVideo: false,
          hasAudio: false,
          transcriptionStatus: 'complete'
        }],
        'recording:get-detail': () => ({
          title: 'Weekly product sync',
          sourceName: 'Google Meet',
          date: meetingDate,
          durationSeconds: 2280
        }),
        'recording:get-media': () => ({ hasVideo: false, hasAudio: false }),
        'recording:update-title': () => undefined,
        'recording:delete': () => undefined,
        'transcription:get-status': () => 'complete',
        'transcription:get-progress': () => undefined,
        'transcription:get-transcript': () => transcript,
        'transcription:retry': () => undefined,
        'segmentation:get-status': () => 'complete',
        'segmentation:get-progress': () => undefined,
        'segmentation:get-error-code': () => undefined,
        'segmentation:get-segments': () => segments,
        'segmentation:retry': () => undefined,
        'segmentation:save-segments': () => undefined,
        'speakers:get': () => speakers,
        'speakers:rename': (_meetingId, speakerId, label) => {
          speakers[speakerId] = { label };
        },
        'whisper:get-setup-status': () => ({ phase: 'ready', percent: 100 }),
        'ollama:get-setup-status': () => ({ phase: 'ready', percent: 100 }),
        'ollama:check-status': () => true,
        'chat:new': () => undefined,
        'chat:cancel': () => undefined,
        'chat:send-stream': (requestId) => {
          queueMicrotask(() => {
            window.electronAPI.emit('chat:done', {
              requestId,
              content: askAiMessages[1].content
            });
          });
        },
        'chat:select-recording-stream': (requestId) => {
          queueMicrotask(() => {
            window.electronAPI.emit('chat:done', {
              requestId,
              content: askAiMessages[1].content
            });
          });
        },
        'search:query': () => []
      };

      window.electronAPI = {
        send: () => undefined,
        invoke: (channel, ...args) => {
          const handler = handlers[channel];
          if (!handler) {
            console.warn('[capture mock] unhandled invoke', channel, args);
            return Promise.resolve(undefined);
          }
          return Promise.resolve(typeof handler === 'function' ? handler(...args) : handler);
        },
        on: (channel, listener) => {
          const set = listeners.get(channel) ?? new Set();
          set.add(listener);
          listeners.set(channel, set);
          return () => {
            set.delete(listener);
            if (set.size === 0) listeners.delete(channel);
          };
        },
        emit: (channel, payload) => {
          const set = listeners.get(channel);
          if (!set) return;
          for (const listener of set) listener(payload);
        }
      };
    })();
  `
}

function rendererHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>AutoDoc README Capture</title>
  </head>
  <body>
    <div id="root"></div>
    <script>${buildMockScript()}</script>
    <script type="module" src="/src/renderer/src/main.tsx"></script>
  </body>
</html>`
}

async function startRendererServer() {
  const [{ createServer }, reactModule, tailwindModule] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-react'),
    import('@tailwindcss/vite')
  ])
  const react = reactModule.default
  const tailwindcss = tailwindModule.default
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false
    },
    plugins: [
      {
        name: 'autodoc-readme-capture-html',
        configureServer(viteServer) {
          viteServer.middlewares.use('/capture.html', async (_req, res) => {
            const html = await viteServer.transformIndexHtml('/capture.html', rendererHtml())
            res.setHeader('Content-Type', 'text/html')
            res.end(html)
          })
        }
      },
      tailwindcss(),
      react()
    ]
  })

  await server.listen()
  const url = server.resolvedUrls?.local?.[0]
  if (!url) throw new Error('Unable to determine Vite capture server URL')
  return { server, url }
}

async function captureUrl(page, url, output, viewport = SCREENSHOT_VIEWPORT, waitForText = null) {
  await page.setViewportSize(viewport)
  await page.goto('about:blank')
  await page.goto(url, { waitUntil: 'networkidle' })
  if (waitForText) {
    try {
      await page.getByText(waitForText).first().waitFor({ timeout: 10_000 })
    } catch (error) {
      const bodyText = await page
        .locator('body')
        .innerText()
        .catch(() => '')
      console.error(`[capture] Timed out waiting for "${waitForText}" at ${url}`)
      console.error(bodyText.slice(0, 2000))
      throw error
    }
  }
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: output, fullPage: false })
  await sharp(output).png({ compressionLevel: 9 }).toFile(`${output}.tmp`)
  fs.renameSync(`${output}.tmp`, output)
}

async function captureContent(page, content, output, viewport = SCREENSHOT_VIEWPORT) {
  await page.setViewportSize(viewport)
  await page.setContent(content, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: output, fullPage: false })
  await sharp(output).png({ compressionLevel: 9 }).toFile(`${output}.tmp`)
  fs.renameSync(`${output}.tmp`, output)
}

function detectionHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      font-family: 'DM Sans', system-ui, sans-serif;
      background: #FAFAF7;
      overflow: hidden;
      color: #1A1A17;
    }
    .desktop { position: relative; width: 100%; height: 100%; padding: 74px 68px 54px; }
    .meeting-window {
      position: relative;
      width: min(1040px, calc(100vw - 136px));
      height: min(650px, calc(100vh - 128px));
      margin: 0 auto;
      border: 1px solid rgba(26,26,23,0.16);
      border-radius: 18px;
      background: #232522;
      box-shadow: 0 24px 70px rgba(26,26,23,0.18);
      overflow: hidden;
    }
    .meeting-top {
      height: 44px;
      padding: 0 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #1b1d1b;
      color: rgba(255,255,255,0.78);
      font-size: 12px;
    }
    .traffic { display: flex; gap: 7px; }
    .traffic span { width: 11px; height: 11px; border-radius: 50%; display: block; }
    .traffic span:nth-child(1) { background: #ff645f; }
    .traffic span:nth-child(2) { background: #ffc35a; }
    .traffic span:nth-child(3) { background: #33c759; }
    .meeting-grid {
      height: calc(100% - 92px);
      padding: 18px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    .tile {
      position: relative;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
      background: linear-gradient(135deg, #3f463e, #272b28);
    }
    .tile:nth-child(2) { background: linear-gradient(135deg, #463b34, #2d2926); }
    .tile:nth-child(3) { background: linear-gradient(135deg, #393848, #282832); }
    .tile:nth-child(4) { background: linear-gradient(135deg, #3a4449, #272d30); }
    .avatar {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: rgba(255,255,255,0.88);
      font-size: 76px;
      font-family: Georgia, serif;
    }
    .tile-name {
      position: absolute;
      left: 12px;
      bottom: 12px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(0,0,0,0.38);
      color: rgba(255,255,255,0.88);
      font-size: 12px;
    }
    .meeting-controls {
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: #1b1d1b;
    }
    .control {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.08);
    }
    .control.end { width: 64px; border-radius: 999px; background: #b94b45; border-color: transparent; }
    .notification-shell {
      position: absolute;
      top: 16px;
      left: 50%;
      width: 400px;
      height: 128px;
      transform: translateX(-50%);
      padding: 6px 12px 20px;
      background: transparent;
    }
    .toast {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 14px 14px 16px;
      background: rgba(255, 255, 255, 0.98);
      backdrop-filter: blur(24px) saturate(1.4);
      border: 1px solid rgba(0, 0, 0, 0.06);
      border-radius: 16px;
      box-shadow:
        0 12px 40px rgba(0, 0, 0, 0.10),
        0 4px 12px rgba(0, 0, 0, 0.04),
        0 0 0 0.5px rgba(0, 0, 0, 0.03);
      font-family: 'DM Sans', system-ui, sans-serif;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #7A9E7E;
      flex-shrink: 0;
    }
    .text { flex: 1; min-width: 0; }
    .title {
      font-size: 13px;
      font-weight: 600;
      color: #1A1A17;
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .subtitle {
      font-size: 11.5px;
      color: #86837e;
      line-height: 1.25;
      margin-top: 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .btn-record {
      padding: 7px 16px;
      border-radius: 10px;
      border: none;
      background: #1A1A17;
      color: white;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 600;
      white-space: nowrap;
    }
    .btn-x {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: none;
      background: transparent;
      color: #c4c1bc;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .btn-x svg { width: 12px; height: 12px; }
    .cursor {
      position: absolute;
      top: 110px;
      left: calc(50% + 126px);
      width: 0;
      height: 0;
      border-left: 10px solid #1A1A17;
      border-top: 7px solid transparent;
      border-bottom: 7px solid transparent;
      filter: drop-shadow(0 4px 7px rgba(0,0,0,0.24));
      transform: rotate(18deg);
    }
  </style>
</head>
<body>
  <div class="desktop">
    <div class="meeting-window">
      <div class="meeting-top">
        <div class="traffic"><span></span><span></span><span></span></div>
        <strong>Weekly product sync</strong>
        <span>Video call</span>
      </div>
      <div class="meeting-grid">
        ${['Alex', 'Jordan', 'Priya', 'Launch'].map((name) => `<div class="tile"><div class="avatar">${name[0]}</div><div class="tile-name">${name}</div></div>`).join('')}
      </div>
      <div class="meeting-controls">
        <div class="control"></div><div class="control"></div><div class="control end"></div><div class="control"></div>
      </div>
    </div>
    <div class="notification-shell">
      <div class="toast">
        <div class="dot"></div>
        <div class="text">
          <div class="title">Meeting detected</div>
          <div class="subtitle">Would you like to start AI notes?</div>
        </div>
        <div class="actions">
          <button class="btn-record">Start AI Notes</button>
          <button class="btn-x">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div class="cursor"></div>
  </div>
</body>
</html>`
}

function ensurePillowAvailable() {
  const check = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' })
  if (check.error || check.status !== 0) {
    throw new Error(
      'Python 3 with the Pillow library is required to build the hero GIF.\n' +
        'Install it with: python3 -m pip install Pillow'
    )
  }
}

function makeGifWithPillow(frameDir, output, frameCount) {
  ensurePillowAvailable()
  const python = `
from PIL import Image
from pathlib import Path
frames = []
for i in range(${frameCount}):
    img = Image.open(Path(r"${frameDir}") / f"frame-{i:03d}.png").convert("RGB")
    img = img.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    frames.append(img)
frames[0].save(r"${output}", save_all=True, append_images=frames[1:], duration=500, loop=0, optimize=True, disposal=2)
`
  const result = spawnSync('python3', ['-c', python], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Pillow GIF export failed:\n${result.stderr || result.stdout}`)
  }
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  fs.mkdirSync(TMP_DIR, { recursive: true })

  const { server, url } = await startRendererServer()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: SCREENSHOT_VIEWPORT, deviceScaleFactor: 1 })
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      console.warn(`[browser ${message.type()}] ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    console.error('[browser pageerror]', error)
  })

  try {
    await captureContent(page, detectionHtml(), path.join(SCREENSHOT_DIR, 'detection.png'))
    await captureUrl(
      page,
      `${url}capture.html#/recordings/${MEETING_ID}?tab=transcript`,
      path.join(SCREENSHOT_DIR, 'transcript.png'),
      SCREENSHOT_VIEWPORT,
      'Jordan'
    )
    await captureUrl(
      page,
      `${url}capture.html#/recordings/${MEETING_ID}?tab=notes`,
      path.join(SCREENSHOT_DIR, 'notes.png'),
      SCREENSHOT_VIEWPORT,
      'Release candidate date'
    )
    await captureUrl(
      page,
      `${url}capture.html#/ask-ai`,
      path.join(SCREENSHOT_DIR, 'ask-ai.png'),
      SCREENSHOT_VIEWPORT,
      'What did we decide about the release candidate?'
    )

    const frameDir = path.join(TMP_DIR, 'frames')
    fs.mkdirSync(frameDir, { recursive: true })

    const frameCount = 60
    for (let i = 0; i < frameCount; i += 1) {
      const output = path.join(frameDir, `frame-${String(i).padStart(3, '0')}.png`)
      const seconds = i / 2
      // Hero GIF leads with the recording state and the payoff (transcript →
      // notes → Ask AI). Detection has its own screenshot in the grid, so it is
      // intentionally not part of this loop to keep the hero visually distinct.
      if (seconds < 4) {
        await captureUrl(
          page,
          `${url}capture.html?recording=1#/recordings`,
          output,
          GIF_VIEWPORT,
          'Weekly product sync'
        )
      } else if (seconds < 12) {
        await captureUrl(
          page,
          `${url}capture.html#/recordings/${MEETING_ID}?tab=transcript`,
          output,
          GIF_VIEWPORT,
          'Jordan'
        )
      } else if (seconds < 20) {
        await captureUrl(
          page,
          `${url}capture.html#/recordings/${MEETING_ID}?tab=notes`,
          output,
          GIF_VIEWPORT,
          'Release candidate date'
        )
      } else {
        await captureUrl(
          page,
          `${url}capture.html#/ask-ai`,
          output,
          GIF_VIEWPORT,
          'What did we decide about the release candidate?'
        )
      }
    }

    makeGifWithPillow(frameDir, path.join(ASSET_DIR, 'demo.gif'), frameCount)

    const outputs = [
      path.join(ASSET_DIR, 'demo.gif'),
      path.join(SCREENSHOT_DIR, 'detection.png'),
      path.join(SCREENSHOT_DIR, 'transcript.png'),
      path.join(SCREENSHOT_DIR, 'notes.png'),
      path.join(SCREENSHOT_DIR, 'ask-ai.png')
    ]

    for (const file of outputs) {
      const stats = fs.statSync(file)
      console.log(`${path.relative(ROOT, file)} ${(stats.size / 1024).toFixed(0)} KB`)
    }
  } finally {
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
