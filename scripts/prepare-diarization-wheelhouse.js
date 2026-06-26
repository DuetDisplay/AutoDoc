#!/usr/bin/env node

const { access, mkdir, readFile, readdir, rm, stat, writeFile } = require('fs/promises')
const { join } = require('path')
const { spawn } = require('child_process')

const REQUIREMENTS_PATH = join(process.cwd(), 'resources', 'diarization-requirements.txt')
const OUTPUT_DIR = join(process.cwd(), 'vendor', 'python-runtime-bundle')
const PYTHON_RELEASE_TAG = '20260414'
const PYTHON_VERSION = '3.11.15'
const BUNDLE_FORMAT = 'preinstalled-runtime-v3-validated'

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

function getArchivePath(target) {
  return join(process.cwd(), 'vendor', 'python-runtime', getArchiveFilename(target))
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
    const proc = spawn(command, args, {
      stdio: 'inherit',
      env: { ...env, COPYFILE_DISABLE: env.COPYFILE_DISABLE ?? '1' },
      windowsHide: true
    })
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

async function reseedManagedPythonRuntime(targetKey, target) {
  const runtimeDir = join(OUTPUT_DIR, targetKey)
  const archivePath = getArchivePath(target)
  if (!(await fileExists(archivePath))) {
    throw new Error(`Managed Python archive not found at ${archivePath}. Run prepare-python-runtime first.`)
  }

  await rm(runtimeDir, { recursive: true, force: true })
  await mkdir(runtimeDir, { recursive: true })
  await run('tar', ['-xzf', archivePath, '-C', runtimeDir])

  const pythonPath = join(runtimeDir, ...target.executable)
  if (!(await fileExists(pythonPath))) {
    throw new Error(`Managed Python runtime extracted without expected executable: ${pythonPath}`)
  }

  return pythonPath
}

function getReadyMarkerPath(targetKey) {
  return join(OUTPUT_DIR, targetKey, 'AUTODOC_DIARIZATION_READY.txt')
}

async function isRuntimeReady(targetKey) {
  const markerPath = getReadyMarkerPath(targetKey)
  if (!(await fileExists(markerPath))) {
    return false
  }

  try {
    const contents = await readFile(markerPath, 'utf8')
    return contents.includes(`mode=${BUNDLE_FORMAT}`)
  } catch {
    return false
  }
}

async function walkAndPrune(rootPath, pruneFn) {
  const entries = await readdir(rootPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name)
    const shouldPrune = await pruneFn(entryPath, entry)
    if (shouldPrune) {
      await rm(entryPath, { recursive: true, force: true })
      continue
    }

    if (entry.isDirectory()) {
      await walkAndPrune(entryPath, pruneFn)
    }
  }
}

async function pruneBundledRuntime(targetKey) {
  const runtimeDir = join(OUTPUT_DIR, targetKey)
  const sitePackagesDir = join(runtimeDir, 'python', 'lib', 'python3.11', 'site-packages')
  const windowsSitePackagesDir = join(runtimeDir, 'python', 'Lib', 'site-packages')

  const removePaths = [
    join(sitePackagesDir, 'torch', 'include'),
    join(sitePackagesDir, 'torch', 'share'),
  ]

  if (targetKey.startsWith('win32-')) {
    removePaths.push(
      // We only ever invoke the console interpreter in production.
      join(runtimeDir, 'python', 'pythonw.exe'),
      // CLI shims are only useful during installation/build time.
      join(runtimeDir, 'python', 'Scripts'),
      join(runtimeDir, 'python', 'Lib', 'venv', 'scripts', 'nt'),
      // setuptools and distlib ship Windows launcher stubs we never execute in-app.
      join(windowsSitePackagesDir, 'setuptools', 'cli-32.exe'),
      join(windowsSitePackagesDir, 'setuptools', 'cli-64.exe'),
      join(windowsSitePackagesDir, 'setuptools', 'cli-arm64.exe'),
      join(windowsSitePackagesDir, 'setuptools', 'cli.exe'),
      join(windowsSitePackagesDir, 'setuptools', 'gui-32.exe'),
      join(windowsSitePackagesDir, 'setuptools', 'gui-64.exe'),
      join(windowsSitePackagesDir, 'setuptools', 'gui-arm64.exe'),
      join(windowsSitePackagesDir, 'setuptools', 'gui.exe'),
      join(windowsSitePackagesDir, 'pip', '_vendor', 'distlib', 't32.exe'),
      join(windowsSitePackagesDir, 'pip', '_vendor', 'distlib', 't64.exe'),
      join(windowsSitePackagesDir, 'pip', '_vendor', 'distlib', 't64-arm.exe'),
      join(windowsSitePackagesDir, 'pip', '_vendor', 'distlib', 'w32.exe'),
      join(windowsSitePackagesDir, 'pip', '_vendor', 'distlib', 'w64.exe'),
      join(windowsSitePackagesDir, 'pip', '_vendor', 'distlib', 'w64-arm.exe'),
      // protobuf tooling is not needed at runtime.
      join(windowsSitePackagesDir, 'torch', 'bin', 'protoc.exe'),
    )
  }

  for (const removePath of removePaths) {
    await rm(removePath, { recursive: true, force: true })
  }

  await walkAndPrune(runtimeDir, async (entryPath, entry) => {
    if (entry.isDirectory()) {
      return (
        entry.name.startsWith('._') ||
        entry.name === '__pycache__' ||
        entry.name === 'tests' ||
        entry.name === 'test'
      )
    }

    if (!entry.isFile()) {
      return false
    }

    return (
      entry.name.startsWith('._') ||
      entry.name === '.DS_Store' ||
      entry.name.endsWith('.pyc') ||
      entry.name.endsWith('.pyo') ||
      entry.name.endsWith('.a') ||
      entry.name.endsWith('.h') ||
      entry.name.endsWith('.hpp') ||
      entry.name.endsWith('.cuh')
    )
  })

  const runtimeInfo = await stat(runtimeDir)
  if (!runtimeInfo.isDirectory()) {
    throw new Error(`Bundled diarization runtime directory is missing after pruning: ${runtimeDir}`)
  }
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

  await ensureManagedPythonExtracted(targetKey, target)
  const pythonPath = await reseedManagedPythonRuntime(targetKey, target)
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

  await pruneBundledRuntime(targetKey)
  await run(pythonPath, [
    '-c',
    'import torch.testing; from pyannote.audio import Pipeline; print("ok")',
  ], { ...process.env, PYTHONDONTWRITEBYTECODE: '1' })
  await pruneBundledRuntime(targetKey)

  await writeFile(
    getReadyMarkerPath(targetKey),
    [
      `target=${targetKey}`,
      `python=${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}`,
      'requirements=resources/diarization-requirements.txt',
      `mode=${BUNDLE_FORMAT}`,
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
