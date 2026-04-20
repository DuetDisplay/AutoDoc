#!/usr/bin/env node

const { access, mkdir, rm } = require('fs/promises')
const { join } = require('path')
const { spawn } = require('child_process')

const HF_TOKEN = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || ''
const MODEL_ID = 'pyannote/speaker-diarization-community-1'
const MODEL_DIR = join(process.cwd(), 'vendor', 'diarization-model', 'community-1')
const TMP_DIR = join(process.cwd(), 'vendor', '.tmp', 'diarization-python')
const PYTHON_RELEASE_TAG = '20260414'
const PYTHON_VERSION = '3.11.15'

const TARGETS = {
  'darwin-arm64': {
    executable: ['python', 'bin', 'python3'],
    triplet: 'aarch64-apple-darwin',
  },
  'darwin-x64': {
    executable: ['python', 'bin', 'python3'],
    triplet: 'x86_64-apple-darwin',
  },
  'win32-arm64': {
    executable: ['python', 'python.exe'],
    triplet: 'aarch64-pc-windows-msvc',
  },
  'win32-x64': {
    executable: ['python', 'python.exe'],
    triplet: 'x86_64-pc-windows-msvc',
  },
}

function getCurrentTarget() {
  return TARGETS[`${process.platform}-${process.arch}`] ?? null
}

function getArchiveFilename(target) {
  return `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-${target.triplet}-install_only.tar.gz`
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'inherit', env, windowsHide: true })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

async function ensureManagedPythonExtracted(target) {
  const archivePath = join(process.cwd(), 'vendor', 'python-runtime', getArchiveFilename(target))
  if (!(await fileExists(archivePath))) {
    throw new Error(`Managed Python archive not found at ${archivePath}. Run prepare-python-runtime first.`)
  }

  const pythonPath = join(TMP_DIR, ...target.executable)
  if (await fileExists(pythonPath)) {
    return pythonPath
  }

  await rm(TMP_DIR, { recursive: true, force: true })
  await mkdir(TMP_DIR, { recursive: true })
  await run('tar', ['-xzf', archivePath, '-C', TMP_DIR])
  return pythonPath
}

async function ensureModelSnapshot() {
  const target = getCurrentTarget()
  if (!target) {
    console.log('[diarization-model] Unsupported build platform; skipping')
    return
  }

  if (!HF_TOKEN) {
    throw new Error(
      'HF_TOKEN/HUGGINGFACE_TOKEN is required to bundle the speaker diarization model. Add it to your local environment or CI secrets before running the build.',
    )
  }

  const configPath = join(MODEL_DIR, 'config.yaml')
  if (await fileExists(configPath)) {
    console.log('[diarization-model] Reusing bundled community-1 snapshot')
    return
  }

  const pythonPath = await ensureManagedPythonExtracted(target)
  await run(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'huggingface_hub'])
  await mkdir(join(process.cwd(), 'vendor', 'diarization-model'), { recursive: true })

  const code = [
    'import os',
    'from huggingface_hub import snapshot_download',
    'snapshot_download(',
    `    repo_id="${MODEL_ID}",`,
    `    local_dir=r"${MODEL_DIR}",`,
    '    token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN"),',
    '    local_dir_use_symlinks=False,',
    ')',
  ].join('\n')

  console.log('[diarization-model] Downloading bundled community-1 snapshot')
  await run(
    pythonPath,
    ['-c', code],
    {
      ...process.env,
      HF_TOKEN,
      HUGGINGFACE_TOKEN: HF_TOKEN,
    },
  )
}

ensureModelSnapshot().catch((err) => {
  console.error('[diarization-model] Failed to prepare bundled speaker diarization model')
  console.error(err)
  process.exitCode = 1
})
