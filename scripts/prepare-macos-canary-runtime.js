#!/usr/bin/env node

const { access, mkdir, readFile, readdir, rm, copyFile, writeFile } = require('fs/promises')
const { createHash } = require('crypto')
const { join } = require('path')
const { spawn } = require('child_process')

const TARGET = 'darwin-arm64'
const PYTHON = '3.11.15+20260414'
const ROOT = join(process.cwd(), 'vendor', 'canary-mlx-runtime', TARGET)
const PYTHON_PATH = join(ROOT, 'python', 'bin', 'python3')
const REQUIREMENTS = join(process.cwd(), 'resources', 'canary-runtime-requirements.txt')
const PROVENANCE = join(process.cwd(), 'resources', 'canary-runtime-provenance.json')
const MARKER = join(ROOT, 'AUTODOC_CANARY_MLX_READY.txt')
const WHEELS = join(ROOT, '_wheelhouse')
const PROBE =
  'from mlx_audio.stt import load; from mlx_audio.stt.models.canary import Model; import onnx_asr; print("Canary imports OK")'

function run(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        COPYFILE_DISABLE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1'
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))
    )
  })
}

async function prune(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (
      entry.name.startsWith('._') ||
      ['.DS_Store', '__pycache__', 'tests', 'test'].includes(entry.name) ||
      /\.(pyc|pyo|a|h|hpp)$/.test(entry.name)
    ) {
      await rm(path, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      await prune(path)
    }
  }
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.log('[canary-runtime] Skipping: requires a darwin-arm64 build host.')
    return
  }
  const lockHash = createHash('sha256')
    .update(await readFile(REQUIREMENTS))
    .digest('hex')
  const marker = `target=${TARGET}\npython=${PYTHON}\nmode=canary-mlx-runtime-v1\nrequirementsSha256=${lockHash}\n`
  try {
    if ((await readFile(MARKER, 'utf8')) === marker) {
      await run(PYTHON_PATH, ['-c', PROBE])
      console.log('[canary-runtime] Reusing bundled Canary runtime')
      return
    }
  } catch {
    /* Rebuild an absent or incomplete runtime. */
  }

  const archive = join(
    process.cwd(),
    'vendor',
    'python-runtime',
    `cpython-${PYTHON}-aarch64-apple-darwin-install_only.tar.gz`
  )
  await access(archive)
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(WHEELS, { recursive: true })
  await run('tar', ['-xzf', archive, '-C', ROOT])
  // No source builds, resolver drift, or dependencies installed into English's runtime.
  await run(PYTHON_PATH, [
    '-m',
    'pip',
    'download',
    '--no-deps',
    '--only-binary=:all:',
    '--require-hashes',
    '--platform',
    'macosx_14_0_arm64',
    '--implementation',
    'cp',
    '--python-version',
    '311',
    '--abi',
    'cp311',
    '--dest',
    WHEELS,
    '-r',
    REQUIREMENTS
  ])
  await run(PYTHON_PATH, [
    '-m',
    'pip',
    'install',
    '--no-deps',
    '--no-index',
    '--only-binary=:all:',
    '--require-hashes',
    '--find-links',
    WHEELS,
    '-r',
    REQUIREMENTS
  ])
  await run(PYTHON_PATH, ['-m', 'pip', 'check'])
  await rm(WHEELS, { recursive: true, force: true })
  await prune(ROOT)
  await run(PYTHON_PATH, ['-c', PROBE])
  await copyFile(PROVENANCE, join(ROOT, 'provenance.json'))
  await writeFile(MARKER, marker)
  console.log(`[canary-runtime] Prepared ${ROOT}`)
}

main().catch((error) => {
  console.error('[canary-runtime] Failed:', error)
  process.exitCode = 1
})
