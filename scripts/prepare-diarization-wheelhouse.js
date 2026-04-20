#!/usr/bin/env node

const { access, mkdir, rm, writeFile } = require('fs/promises')
const { join } = require('path')
const { spawn } = require('child_process')

const REQUIREMENTS_PATH = join(process.cwd(), 'resources', 'diarization-requirements.txt')
const OUTPUT_DIR = join(process.cwd(), 'vendor', 'python-runtime-bundle')
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
  const pythonPath = join(OUTPUT_DIR, targetKey, ...target.executable)
  if (!(await fileExists(pythonPath))) {
    throw new Error(`Managed Python runtime not found at ${pythonPath}. Run prepare-python-runtime first.`)
  }
  return pythonPath
}

function getReadyMarkerPath(targetKey) {
  return join(OUTPUT_DIR, targetKey, 'AUTODOC_DIARIZATION_READY.txt')
}

async function isRuntimeReady(targetKey) {
  return fileExists(getReadyMarkerPath(targetKey))
}

async function ensureBundledRuntime(targetKey) {
  const target = TARGETS[targetKey]
  if (!target) {
    console.log(`[diarization-runtime] Unsupported target ${targetKey}; skipping`)
    return
  }

  if (targetKey !== getCurrentTargetKey()) {
    console.warn(
      `[diarization-runtime] Skipping ${targetKey}: dependency bundling currently runs on the matching host platform/arch only.`,
    )
    return
  }

  if (await isRuntimeReady(targetKey)) {
    console.log(`[diarization-runtime] Reusing bundled diarization runtime for ${targetKey}`)
    return
  }

  const pythonPath = await ensureManagedPythonExtracted(targetKey, target)
  const runtimeDir = join(OUTPUT_DIR, targetKey)
  await mkdir(runtimeDir, { recursive: true })

  console.log(`[diarization-runtime] Installing diarization dependencies into bundled runtime for ${targetKey}`)
  await run(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'])
  await run(pythonPath, [
    '-m',
    'pip',
    'install',
    '--requirement',
    REQUIREMENTS_PATH,
  ])

  await writeFile(
    getReadyMarkerPath(targetKey),
    [
      `target=${targetKey}`,
      `python=${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}`,
      'requirements=resources/diarization-requirements.txt',
      'mode=preinstalled-runtime',
    ].join('\n'),
  )
}

async function main() {
  const targetKey = process.env.AUTODOC_DIARIZATION_WHEELHOUSE_TARGET?.trim() || getCurrentTargetKey()
  await ensureBundledRuntime(targetKey)
}

main().catch((err) => {
  console.error('[diarization-runtime] Failed to prepare bundled diarization runtime')
  console.error(err)
  process.exitCode = 1
})
