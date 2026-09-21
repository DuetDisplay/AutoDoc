/* eslint-disable @typescript-eslint/no-require-imports -- Electron bootstrap patches CommonJS builtins before loading the app. */
// Electron-only fault injection for the real-app notes-model regression tests.
// Production modules are unchanged; only hardware timing and Ollama availability
// are controlled. Successful generation still goes to the real local model.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const cp = require('node:child_process')
const os = require('node:os')
const { app } = require('electron')
if (process.env.AUTODOC_DML_FAILURE_VERIFY === '1') require('./dml-failure-bootstrap.cjs')

const scenario = process.env.AUTODOC_NOTES_VERIFY_SCENARIO
const root = process.env.AUTODOC_TEST_USER_DATA_DIR
const trace = path.join(root, 'model-requests.jsonl')
const record = (entry) =>
  fs.appendFileSync(trace, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n')
// These isolated runs must never change login registration or contact telemetry.
app.setLoginItemSettings = () => {}

// Jamal's reported capacity selects win-low-spec after CPU recovery. Keep actual
// GPU discovery, model assets and all generation requests real for this fixture.
if (process.env.AUTODOC_VERIFY_JAMAL_HARDWARE === '1') {
  process.getSystemMemoryInfo = () => ({
    total: Math.round(15.77 * 1024 ** 2),
    free: Math.round(6.7 * 1024 ** 2),
    swapTotal: 0,
    swapFree: 0
  })
  os.availableParallelism = () => 8
}

if (scenario !== 'normal') {
  process.getSystemMemoryInfo = () => ({
    total: Math.round(15.3 * 1024 ** 2),
    free: 6 * 1024 ** 2,
    swapTotal: 0,
    swapFree: 0
  })
  os.availableParallelism = () => 16
  const execFile = cp.execFile
  cp.execFile = function (file, args, ...rest) {
    const callback = rest.at(-1)
    const command = Array.isArray(args) ? args.join(' ') : ''
    let stdout
    if (command.includes('Win32_VideoController'))
      stdout = JSON.stringify([
        { Name: 'NVIDIA GeForce RTX 4050 Laptop GPU', AdapterRAM: 6 * 1024 ** 3 }
      ])
    else if (command.includes('qwMemorySize')) stdout = '[]'
    else if (String(file).includes('nvidia-smi'))
      stdout = 'NVIDIA GeForce RTX 4050 Laptop GPU, 6144, 570.00'
    if (stdout !== undefined && typeof callback === 'function') {
      queueMicrotask(() => callback(null, stdout, ''))
      return { pid: 0 }
    }
    return execFile.call(this, file, args, ...rest)
  }
  cp.execFile[require('node:util').promisify.custom] = (file, args, options) =>
    new Promise((resolve, reject) => {
      cp.execFile(file, args, ...(options ? [options] : []), (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout, stderr })
      )
    })
  const readFile = fsp.readFile
  fsp.readFile = async function (file, ...args) {
    if (String(file).endsWith('windows-transcription-manifest.json'))
      await new Promise((resolve) => setTimeout(resolve, 1500))
    return readFile.call(this, file, ...args)
  }
}

const originalFetch = global.fetch
let qwenAvailable = scenario === 'normal'
let legacyAvailable = scenario === 'legacy'
let legacyStarted
const legacyGenerationStarted = new Promise((resolve) => {
  legacyStarted = resolve
})
global.fetch = async function (input, options) {
  const url = String(input)
  if (!url.startsWith('http://127.0.0.1:11435/')) return originalFetch(input, options)
  const endpoint = new URL(url).pathname
  const body = options?.body ? JSON.parse(String(options.body)) : {}
  if (scenario !== 'normal' && endpoint === '/api/tags') {
    // Probe the real server first: do not fabricate server readiness.
    const response = await originalFetch(input, options).catch((error) => {
      record({ endpoint, error: error.message })
      throw error
    })
    record({ endpoint, status: response.status })
    if (!response.ok) return response
    const models = [
      'llama3.2:3b',
      ...(qwenAvailable ? ['qwen3:4b-instruct'] : []),
      ...(legacyAvailable ? ['llama3.1'] : [])
    ]
    return Response.json({ models: models.map((name) => ({ name })) })
  }
  if (scenario !== 'normal' && endpoint === '/api/pull') {
    record({ endpoint, model: body.name ?? body.model })
    if (scenario === 'legacy') await legacyGenerationStarted
    await new Promise((resolve) => setTimeout(resolve, 300))
    if ((body.name ?? body.model) === 'qwen3:4b-instruct') qwenAvailable = true
    record({ endpoint, model: body.name ?? body.model, completed: true })
    return new Response('{"status":"success"}\n', {
      headers: { 'Content-Type': 'application/x-ndjson' }
    })
  }
  if (scenario !== 'normal' && endpoint === '/api/delete') {
    record({ endpoint, model: body.name ?? body.model })
    if ((body.name ?? body.model) === 'llama3.1') legacyAvailable = false
    return Response.json({})
  }
  if (endpoint === '/api/generate' || endpoint === '/api/chat') {
    const missing =
      scenario !== 'normal' &&
      ((body.model === 'qwen3:4b-instruct' && !qwenAvailable) ||
        (body.model === 'llama3.1' && !legacyAvailable))
    record({ endpoint, model: body.model, unload: body.keep_alive === 0, missing })
    if (missing)
      return Response.json({ error: "model 'qwen3:4b-instruct' not found" }, { status: 404 })
    if (scenario === 'legacy' && body.model === 'llama3.1') {
      legacyStarted()
      // Test the model-binding lifecycle with the installed Qwen weights.
      // The request trace preserves the application's original model identity.
      return originalFetch(input, {
        ...options,
        body: JSON.stringify({ ...body, model: 'qwen3:4b-instruct' })
      })
    }
  }
  return originalFetch(input, options)
}

require(process.env.AUTODOC_NOTES_VERIFY_ENTRY || path.join(process.cwd(), 'out/main/index.js'))
