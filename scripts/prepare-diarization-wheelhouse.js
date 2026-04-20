#!/usr/bin/env node

const { access, mkdir, rm, readdir, writeFile } = require('fs/promises')
const { join } = require('path')
const { spawn } = require('child_process')

const REQUIREMENTS_PATH = join(process.cwd(), 'resources', 'diarization-requirements.txt')
const OUTPUT_DIR = join(process.cwd(), 'vendor', 'diarization-wheelhouse')
const TMP_DIR = join(process.cwd(), 'vendor', '.tmp', 'diarization-wheelhouse-python')
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

function getCurrentTargetKey() {
  return `${process.platform}-${process.arch}`
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

async function ensureManagedPythonExtracted(targetKey, target) {
  const archivePath = join(process.cwd(), 'vendor', 'python-runtime', getArchiveFilename(target))
  if (!(await fileExists(archivePath))) {
    throw new Error(`Managed Python archive not found at ${archivePath}. Run prepare-python-runtime first.`)
  }

  const pythonPath = join(TMP_DIR, targetKey, ...target.executable)
  if (await fileExists(pythonPath)) {
    return pythonPath
  }

  await rm(join(TMP_DIR, targetKey), { recursive: true, force: true })
  await mkdir(join(TMP_DIR, targetKey), { recursive: true })
  await run('tar', ['-xzf', archivePath, '-C', join(TMP_DIR, targetKey)])
  return pythonPath
}

async function isWheelhouseReady(targetKey) {
  const wheelhouseDir = join(OUTPUT_DIR, targetKey)
  if (!(await fileExists(wheelhouseDir))) {
    return false
  }

  const entries = await readdir(wheelhouseDir)
  return entries.some((entry) => entry.endsWith('.whl'))
}

async function ensureWheelhouse(targetKey) {
  const target = TARGETS[targetKey]
  if (!target) {
    console.log(`[diarization-wheelhouse] Unsupported target ${targetKey}; skipping`)
    return
  }

  if (targetKey !== getCurrentTargetKey()) {
    console.warn(
      `[diarization-wheelhouse] Skipping ${targetKey}: wheel bundling currently runs on the matching host platform/arch only.`,
    )
    return
  }

  if (await isWheelhouseReady(targetKey)) {
    console.log(`[diarization-wheelhouse] Reusing bundled wheels for ${targetKey}`)
    return
  }

  const pythonPath = await ensureManagedPythonExtracted(targetKey, target)
  const wheelhouseDir = join(OUTPUT_DIR, targetKey)
  await rm(wheelhouseDir, { recursive: true, force: true })
  await mkdir(wheelhouseDir, { recursive: true })

  console.log(`[diarization-wheelhouse] Downloading diarization wheels for ${targetKey}`)
  await run(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'])
  await run(pythonPath, [
    '-m',
    'pip',
    'wheel',
    '--wheel-dir',
    wheelhouseDir,
    '--requirement',
    REQUIREMENTS_PATH,
  ])

  await writeFile(
    join(wheelhouseDir, 'MANIFEST.txt'),
    [
      `target=${targetKey}`,
      `python=${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}`,
      'requirements=resources/diarization-requirements.txt',
    ].join('\n'),
  )
}

async function main() {
  const targetKey = process.env.AUTODOC_DIARIZATION_WHEELHOUSE_TARGET?.trim() || getCurrentTargetKey()
  await ensureWheelhouse(targetKey)
}

main().catch((err) => {
  console.error('[diarization-wheelhouse] Failed to prepare bundled diarization wheelhouse')
  console.error(err)
  process.exitCode = 1
})
