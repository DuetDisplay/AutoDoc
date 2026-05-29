#!/usr/bin/env node

const { access, mkdir, readdir, rm, stat, writeFile } = require('fs/promises')
const { join } = require('path')
const { spawn } = require('child_process')

const TARGET_KEY = 'darwin-arm64'
const PYTHON_RELEASE_TAG = '20260414'
const PYTHON_VERSION = '3.11.15'
const ARCHIVE_NAME = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-aarch64-apple-darwin-install_only.tar.gz`
const ARCHIVE_PATH = join(process.cwd(), 'vendor', 'python-runtime', ARCHIVE_NAME)
const OUTPUT_DIR = join(process.cwd(), 'vendor', 'mlx-python-runtime', TARGET_KEY)
const PYTHON_PATH = join(OUTPUT_DIR, 'python', 'bin', 'python3')
const WHEELHOUSE_DIR = join(OUTPUT_DIR, '_wheelhouse')
const READY_MARKER = join(OUTPUT_DIR, 'AUTODOC_MLX_WHISPER_READY.txt')
const BUNDLE_FORMAT = 'mlx-whisper-runtime-v2'
const WHEEL_PLATFORM = 'macosx_14_0_arm64'
// Keep MLX pinned so release builds do not silently move to wheels with a newer
// macOS deployment target than our QA/prod machines support.
const PACKAGES = ['mlx-whisper==0.4.3', 'mlx==0.29.3', 'mlx-metal==0.29.3']

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

async function isRuntimeReady() {
  if (!(await fileExists(READY_MARKER))) return false
  if (!(await fileExists(PYTHON_PATH))) return false
  try {
    const marker = await require('fs/promises').readFile(READY_MARKER, 'utf8')
    return (
      marker.includes(`target=${TARGET_KEY}`) &&
      marker.includes(`python=${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}`) &&
      marker.includes(`mode=${BUNDLE_FORMAT}`) &&
      marker.includes(`wheelPlatform=${WHEEL_PLATFORM}`) &&
      marker.includes(`packages=${PACKAGES.join(',')}`)
    )
  } catch {
    return false
  }
}

async function walkAndPrune(rootPath) {
  const entries = await readdir(rootPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name)
    if (
      entry.name.startsWith('._') ||
      entry.name === '.DS_Store' ||
      entry.name === '__pycache__' ||
      entry.name === 'tests' ||
      entry.name === 'test' ||
      entry.name.endsWith('.pyc') ||
      entry.name.endsWith('.pyo') ||
      entry.name.endsWith('.a') ||
      entry.name.endsWith('.h') ||
      entry.name.endsWith('.hpp')
    ) {
      await rm(entryPath, { recursive: true, force: true })
      continue
    }

    if (entry.isDirectory()) {
      await walkAndPrune(entryPath)
    }
  }
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.log('[mlx-runtime] Skipping: MLX runtime is only prepared on darwin-arm64 hosts.')
    return
  }

  if (await isRuntimeReady()) {
    console.log('[mlx-runtime] Reusing bundled MLX Whisper runtime')
    return
  }

  if (!(await fileExists(ARCHIVE_PATH))) {
    throw new Error(
      `Managed Python archive not found at ${ARCHIVE_PATH}. Run prepare:python-runtime first.`
    )
  }

  await rm(OUTPUT_DIR, { recursive: true, force: true })
  await mkdir(OUTPUT_DIR, { recursive: true })
  console.log('[mlx-runtime] Extracting managed Python runtime')
  await run('tar', ['-xzf', ARCHIVE_PATH, '-C', OUTPUT_DIR])

  if (!(await fileExists(PYTHON_PATH))) {
    throw new Error(`Managed Python runtime extracted without expected executable: ${PYTHON_PATH}`)
  }

  console.log('[mlx-runtime] Installing MLX Whisper dependencies')
  await run(PYTHON_PATH, ['-m', 'pip', 'install', '--upgrade', 'pip'])
  await rm(WHEELHOUSE_DIR, { recursive: true, force: true })
  await mkdir(WHEELHOUSE_DIR, { recursive: true })
  await run(PYTHON_PATH, [
    '-m',
    'pip',
    'download',
    '--only-binary=:all:',
    '--platform',
    WHEEL_PLATFORM,
    '--implementation',
    'cp',
    '--python-version',
    '311',
    '--abi',
    'cp311',
    '--dest',
    WHEELHOUSE_DIR,
    ...PACKAGES
  ])
  await run(PYTHON_PATH, [
    '-m',
    'pip',
    'install',
    '--no-index',
    '--find-links',
    WHEELHOUSE_DIR,
    ...PACKAGES
  ])
  await rm(WHEELHOUSE_DIR, { recursive: true, force: true })
  await walkAndPrune(OUTPUT_DIR)
  await run(PYTHON_PATH, ['-c', 'import mlx_whisper; print("ok")'], {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1'
  })

  const runtimeInfo = await stat(OUTPUT_DIR)
  if (!runtimeInfo.isDirectory()) {
    throw new Error(`Bundled MLX runtime directory is missing after pruning: ${OUTPUT_DIR}`)
  }

  await writeFile(
    READY_MARKER,
    [
      `target=${TARGET_KEY}`,
      `python=${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}`,
      `wheelPlatform=${WHEEL_PLATFORM}`,
      `packages=${PACKAGES.join(',')}`,
      `mode=${BUNDLE_FORMAT}`
    ].join('\n')
  )
  console.log(`[mlx-runtime] Prepared ${OUTPUT_DIR}`)
}

main().catch((err) => {
  console.error('[mlx-runtime] Failed to prepare bundled MLX Whisper runtime')
  console.error(err)
  process.exitCode = 1
})
