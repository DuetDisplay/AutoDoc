import { test, expect, _electron as electron } from '@playwright/test'
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  linkSync,
  cpSync,
  unlinkSync
} from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const enabled = process.env.AUTODOC_NOTES_VERIFY === '1'
const phase = process.env.AUTODOC_NOTES_VERIFY_PHASE ?? 'after'
const artifactRoot = path.join(process.cwd(), 'artifacts', 'notes-model-verification')
const installed =
  process.env.AUTODOC_NOTES_VERIFY_INSTALLED ?? path.join(process.env.APPDATA ?? '', 'AutoDoc')

function prepareSpeechFixture(): void {
  const webm = path.join(artifactRoot, 'speech.webm')
  if (existsSync(webm)) return
  const wav = path.join(artifactRoot, 'speech.wav')
  const speech =
    'Today we reviewed the customer portal launch. We agreed to launch the customer portal on Friday. Alex will send the updated design to Morgan by Thursday. Morgan will review the design and send feedback before the launch. The launch budget is five thousand dollars. We decided to keep the existing login page for this release. The team discussed adding search, but postponed that feature until next month. We will meet again on Monday to review the launch results. Alex owns the design update, and Morgan owns the review. Those are the decisions and action items from this meeting.'
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `
    Add-Type -AssemblyName System.Speech
    $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
      $speaker.Rate = -1
      $speaker.SetOutputToWaveFile($env:AUTODOC_NOTES_VERIFY_WAV)
      $speaker.Speak($env:AUTODOC_NOTES_VERIFY_TEXT)
    } finally { $speaker.Dispose() }
  `
    ],
    {
      windowsHide: true,
      env: { ...process.env, AUTODOC_NOTES_VERIFY_WAV: wav, AUTODOC_NOTES_VERIFY_TEXT: speech }
    }
  )
  execFileSync(
    path.join(installed, 'models', 'ffmpeg.exe'),
    ['-i', wav, '-c:a', 'libopus', '-b:a', '80k', webm],
    { windowsHide: true, stdio: 'pipe' }
  )
}

function linkModelTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) linkModelTree(from, to)
    else if (!existsSync(to)) linkSync(from, to)
  }
}

for (const scenario of ['normal', 'victor', 'legacy'] as const) {
  test(`real application ${scenario}: transcription and notes model readiness`, async () => {
    test.skip(!enabled || process.platform !== 'win32', 'Opt-in real Windows models required.')
    test.skip(
      phase === 'before' && scenario === 'legacy',
      'Legacy lifecycle assertions verify the fixed build.'
    )
    test.setTimeout(12 * 60_000)
    const userData = path.join(
      artifactRoot,
      `${phase}-${scenario}${process.env.AUTODOC_NOTES_VERIFY_RUN_SUFFIX ?? ''}`
    )
    if (existsSync(path.join(userData, 'recordings'))) {
      throw new Error(
        'Use a fresh AUTODOC_NOTES_VERIFY_RUN_SUFFIX; existing recordings must not satisfy a new run.'
      )
    }
    mkdirSync(userData, { recursive: true })
    const models = path.join(userData, 'models')
    mkdirSync(models, { recursive: true })
    // Immutable model data uses independent directory entries. Deletes in this
    // isolated store cannot remove the user's original model files.
    linkModelTree(
      path.join(installed, 'ollama-data', 'blobs'),
      path.join(userData, 'ollama-data', 'blobs')
    )
    cpSync(
      path.join(installed, 'ollama-data', 'manifests'),
      path.join(userData, 'ollama-data', 'manifests'),
      { recursive: true }
    )
    linkModelTree(
      path.join(installed, 'models', 'parakeet-models'),
      path.join(models, 'parakeet-models')
    )
    if (process.env.AUTODOC_VERIFY_CPU_MODELS) {
      linkModelTree(
        process.env.AUTODOC_VERIFY_CPU_MODELS,
        path.join(models, 'parakeet-models', 'parakeet-tdt-0.6b-v3-int8')
      )
    }
    for (const runtime of ['ollama-runtime', 'transcription-runtimes']) {
      if (!existsSync(path.join(models, runtime)))
        cpSync(path.join(installed, 'models', runtime), path.join(models, runtime), {
          recursive: true
        })
    }
    copyFileSync(path.join(installed, 'models', 'ffmpeg.exe'), path.join(models, 'ffmpeg.exe'))
    writeFileSync(
      path.join(userData, 'autodoc-prefs.json'),
      JSON.stringify({
        onboardingComplete: true,
        launchAtLogin: false,
        analyticsConsent: false,
        diagnosticLogUploadConsent: false
      })
    )
    const meetingId = `model-verification-${scenario}`
    const meetingDir = path.join(userData, 'recordings', meetingId)
    mkdirSync(meetingDir, { recursive: true })
    writeFileSync(
      path.join(meetingDir, 'metadata.json'),
      JSON.stringify({
        sourceName: 'Model readiness verification',
        customTitle: `${scenario} model verification`,
        startedAt: Date.now() - 60_000,
        stoppedAt: Date.now(),
        durationSeconds: 45
      })
    )
    if (scenario === 'normal') {
      prepareSpeechFixture()
      copyFileSync(path.join(artifactRoot, 'speech.webm'), path.join(meetingDir, 'mic.webm'))
      if (process.env.AUTODOC_VERIFY_DUAL === '1') {
        copyFileSync(path.join(artifactRoot, 'speech.webm'), path.join(meetingDir, 'system.webm'))
      }
    } else {
      // Victor first generated notes after startup finished. Keep this meeting
      // out of automatic recovery until both startup profiles have settled.
      writeFileSync(
        path.join(meetingDir, 'segments.error'),
        JSON.stringify({ error: 'Fixture waits for startup', retries: 3 })
      )
      writeFileSync(
        path.join(meetingDir, 'transcript.json'),
        JSON.stringify([
          {
            id: '1',
            meetingId,
            speaker: 'me',
            text: 'We agreed to launch the customer portal on Friday. Alex will send the updated design to Morgan by Thursday. The launch budget is five thousand dollars.',
            startMs: 0,
            endMs: 45000,
            confidence: 1
          }
        ])
      )
    }
    const app = await electron.launch({
      args: [path.join(process.cwd(), 'e2e/helpers/notes-model-bootstrap.cjs')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AUTODOC_TEST_MODE: '1',
        AUTODOC_E2E: '0',
        AUTODOC_TEST_REAL_SETUP: '0',
        AUTODOC_SKIP_INSTALL_POLICY: '1',
        AUTODOC_TEST_USER_DATA_DIR: userData,
        AUTODOC_NOTES_VERIFY_SCENARIO: scenario,
        AUTODOC_ASK_AI_EMBEDDINGS: '0',
        ELECTRON_RENDERER_URL: ''
      }
    })
    const stdout: string[] = []
    app.process().stdout?.on('data', (chunk) => stdout.push(chunk.toString()))
    app.process().stderr?.on('data', (chunk) => stdout.push(chunk.toString()))
    try {
      const page = await app.firstWindow()
      await page.getByRole('link', { name: 'AI Notes', exact: true }).click()
      await expect(page.getByText(`${scenario} model verification`, { exact: true })).toBeVisible({
        timeout: 30_000
      })
      if (scenario !== 'normal') {
        await expect
          .poll(
            () =>
              readFileSync(path.join(userData, 'logs', 'autodocLog.log'), 'utf8').includes(
                'Selected Windows transcription backend'
              ),
            { timeout: 30_000 }
          )
          .toBe(true)
        if (scenario === 'legacy') {
          // The upgrade is still downloading, but the installed fallback is usable.
          await expect
            .poll(
              () =>
                readFileSync(path.join(userData, 'logs', 'autodocLog.log'), 'utf8').includes(
                  'notes model approved for generation'
                ),
              { timeout: 90_000 }
            )
            .toBe(true)
        } else {
          await expect
            .poll(
              async () =>
                (await page.evaluate(() => window.electronAPI.invoke('ollama:get-setup-status')))
                  ?.phase,
              { timeout: 90_000 }
            )
            .toBe('ready')
        }
        unlinkSync(path.join(meetingDir, 'segments.error'))
        await page.evaluate((id) => window.electronAPI.invoke('segmentation:retry', id), meetingId)
      }
      const dmlFailure = process.env.AUTODOC_DML_FAILURE_VERIFY === '1'
      if (dmlFailure) {
        // Exercise the existing user retry IPC rather than waiting two minutes
        // per recovery scan. Probe requests execute normally in this fixture.
        let retriedFailures = 0
        while (true) {
          let observedFailures = 0
          await expect
            .poll(
              async () => {
                const file = path.join(userData, 'worker-requests.jsonl')
                const failures = existsSync(file)
                  ? readFileSync(file, 'utf8')
                      .trim()
                      .split('\n')
                      .map((line) => JSON.parse(line))
                      .filter((r) => r.injected).length
                  : 0
                observedFailures = failures
                const status = await page.evaluate(
                  (id) => window.electronAPI.invoke('transcription:get-status', id),
                  meetingId
                )
                return failures > retriedFailures && status === 'failed'
              },
              { timeout: 180_000 }
            )
            .toBe(true)
          const downgraded = readFileSync(
            path.join(userData, 'logs', 'autodocLog.log'),
            'utf8'
          ).includes('Downgrading Parakeet GPU to CPU after repeated DML device-loss failures')
          expect(observedFailures).toBeLessThanOrEqual(6)
          await page.evaluate(
            (id) => window.electronAPI.invoke('transcription:retry', id),
            meetingId
          )
          retriedFailures = observedFailures
          if (downgraded) break
        }
        if (process.env.AUTODOC_JAMAL_BASELINE === '1') {
          await expect
            .poll(
              () => {
                const file = path.join(userData, 'worker-requests.jsonl')
                return existsSync(file)
                  ? readFileSync(file, 'utf8')
                      .trim()
                      .split('\n')
                      .map((line) => JSON.parse(line))
                      .filter((r) => r.injected).length
                  : 0
              },
              { timeout: 240_000 }
            )
            .toBeGreaterThanOrEqual(3)
          const requests = readFileSync(path.join(userData, 'worker-requests.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
          expect(
            requests
              .filter((r) => r.op === 'transcribe' && !r.probe)
              .slice(0, 3)
              .every((r) => r.device === 'dml')
          ).toBe(true)
          await page.screenshot({ path: path.join(artifactRoot, `${phase}-gpu-retry-failure.png`) })
          return
        }
      }
      const expected = phase === 'before' && scenario === 'victor' ? 'Notes failed' : 'Notes ready'
      await expect(page.getByText(expected, { exact: false }).first()).toBeVisible({
        timeout: 9 * 60_000
      })
      await page.screenshot({
        path: path.join(artifactRoot, `${phase}-${scenario}-list.png`),
        fullPage: true
      })
      await page.getByText(`${scenario} model verification`, { exact: true }).click()
      await expect(page.getByRole('button', { name: 'Transcript', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Notes', exact: true })).toBeVisible()
      await page.screenshot({
        path: path.join(artifactRoot, `${phase}-${scenario}-detail.png`),
        fullPage: true
      })
      const result = await page.evaluate(
        async (id) => ({
          transcript: await window.electronAPI.invoke('transcription:get-transcript', id),
          segments: await window.electronAPI.invoke('segmentation:get-segments', id),
          notes: await window.electronAPI.invoke('notes:get-v2', id),
          detail: await window.electronAPI.invoke('recording:get-detail', id)
        }),
        meetingId
      )
      if (dmlFailure) {
        const workerRequests = readFileSync(path.join(userData, 'worker-requests.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(workerRequests.filter((r) => r.injected).length).toBeGreaterThanOrEqual(2)
        if (process.env.AUTODOC_VERIFY_DUAL !== '1')
          expect(workerRequests.filter((r) => r.injected)).toHaveLength(2)
        expect(
          workerRequests.some(
            (r) => r.op === 'transcribe' && r.device === 'cpu' && !r.injected && !r.probe
          )
        ).toBe(true)
      }
      writeFileSync(
        path.join(artifactRoot, `${phase}-${scenario}-result.json`),
        JSON.stringify(result, null, 2)
      )
      const requests = readFileSync(path.join(userData, 'model-requests.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      if (expected === 'Notes failed') expect(requests.some((r) => r.missing)).toBe(true)
      else {
        expect(requests.some((r) => r.missing)).toBe(false)
        expect(result.transcript.length).toBeGreaterThan(0)
        expect(result.segments).toBeTruthy()
      }
      if (dmlFailure && process.env.AUTODOC_VERIFY_JAMAL_HARDWARE === '1') {
        const status = await page.evaluate(() =>
          window.electronAPI.invoke('whisper:get-setup-status')
        )
        expect(status.windowsProcessingProfileId).toBe('win-low-spec')
        expect(requests.some((r) => r.model === 'llama3.2:3b' && !r.unload)).toBe(true)
        const workerRequests = readFileSync(path.join(userData, 'worker-requests.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        // Eight logical CPUs minus the existing six-CPU reserve leaves two.
        expect(
          workerRequests.some((r) => r.op === 'load' && r.device === 'cpu' && r.threads === 2)
        ).toBe(true)
        const completed = readFileSync(path.join(userData, 'logs', 'autodocLog.log'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .find((entry) => entry.message === 'transcription completed')
        expect(completed.context.processingProfile.settings).toMatchObject({
          dualSourceMode: 'sequential',
          threadPolicy: 'min',
          notesAfterTranscriptionOnly: true
        })
      }
      if (phase === 'after' && scenario === 'normal') {
        const baseline = JSON.parse(
          readFileSync(path.join(artifactRoot, 'before-normal-result.json'), 'utf8')
        )
        expect(result.transcript).toEqual(baseline.transcript)
        expect(result.segments).toEqual(baseline.segments)
        const baselineNotes =
          baseline.notes ??
          JSON.parse(readFileSync(path.join(artifactRoot, 'before-normal-notes-v2.json'), 'utf8'))
        expect(result.notes).toEqual(baselineNotes)
      }
      if (scenario === 'legacy') {
        await expect
          .poll(
            () =>
              readFileSync(path.join(userData, 'model-requests.jsonl'), 'utf8').includes(
                '/api/delete'
              ),
            { timeout: 10_000 }
          )
          .toBe(true)
        const lifecycle = readFileSync(path.join(userData, 'model-requests.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const generation = lifecycle.filter(
          (r) => r.endpoint === '/api/chat' || r.endpoint === '/api/generate'
        )
        expect(generation.every((r) => r.model === 'llama3.1' && !r.missing)).toBe(true)
        const unloaded = lifecycle.findIndex((r) => r.unload && r.model === 'llama3.1')
        const deleted = lifecycle.findIndex(
          (r) => r.endpoint === '/api/delete' && r.model === 'llama3.1'
        )
        const pulled = lifecycle.findIndex((r) => r.completed && r.endpoint === '/api/pull')
        expect(pulled).toBeGreaterThan(-1)
        expect(unloaded).toBeGreaterThan(pulled)
        expect(deleted).toBeGreaterThan(unloaded)
        expect(
          lifecycle.some((r) => r.endpoint === '/api/delete' && r.model === 'llama3.2:3b')
        ).toBe(false)
        await page.evaluate((id) => window.electronAPI.invoke('segmentation:retry', id), meetingId)
        await expect
          .poll(
            () =>
              readFileSync(path.join(userData, 'model-requests.jsonl'), 'utf8').includes(
                '"model":"qwen3:4b-instruct","unload":false'
              ),
            { timeout: 30_000 }
          )
          .toBe(true)
        await expect(page.getByText('Notes ready', { exact: true }).first()).toBeVisible({
          timeout: 120_000
        })
      }
      await page.getByRole('button', { name: 'Transcript', exact: true }).click()
      await expect(page.getByText(/customer portal/i).first()).toBeVisible()
      await page.screenshot({
        path: path.join(artifactRoot, `${phase}-${scenario}-transcript.png`),
        fullPage: true
      })
      if (dmlFailure && process.env.AUTODOC_VERIFY_SECOND_MEETING === '1') {
        const secondId = 'model-verification-second-cpu'
        const secondDir = path.join(userData, 'recordings', secondId)
        mkdirSync(secondDir, { recursive: true })
        writeFileSync(
          path.join(secondDir, 'metadata.json'),
          JSON.stringify({
            sourceName: 'Model verification',
            customTitle: 'Subsequent CPU meeting',
            startedAt: Date.now() - 60000,
            stoppedAt: Date.now(),
            durationSeconds: 45
          })
        )
        copyFileSync(path.join(artifactRoot, 'speech.webm'), path.join(secondDir, 'mic.webm'))
        const traceFile = path.join(userData, 'worker-requests.jsonl')
        const beforeLines = readFileSync(traceFile, 'utf8').trim().split('\n').length
        await page.evaluate((id) => window.electronAPI.invoke('transcription:retry', id), secondId)
        await expect
          .poll(
            () =>
              page.evaluate(
                (id) => window.electronAPI.invoke('segmentation:get-status', id),
                secondId
              ),
            { timeout: 240_000 }
          )
          .toBe('complete')
        const later = readFileSync(traceFile, 'utf8')
          .trim()
          .split('\n')
          .slice(beforeLines)
          .map((line) => JSON.parse(line))
          .filter((r) => r.op === 'transcribe' && !r.probe)
        expect(later.length).toBeGreaterThan(0)
        expect(later.every((r) => r.device === 'cpu' && !r.injected)).toBe(true)
      }
    } finally {
      writeFileSync(path.join(artifactRoot, `${phase}-${scenario}-console.log`), stdout.join(''))
      await app.close()
    }
  })
}
