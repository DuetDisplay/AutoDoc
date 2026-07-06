const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { createReadStream } = require('node:fs')
const { cp, mkdir, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises')
const path = require('node:path')

const ROOT = process.cwd()
const RELEASE_TAG =
  process.env.AUTODOC_WINDOWS_TRANSCRIPTION_RELEASE_TAG ?? 'windows-transcription-v2'
const OUT_DIR = path.join(ROOT, '.benchmarks', 'windows-transcription-assets', RELEASE_TAG)
const STAGING_DIR = path.join(OUT_DIR, '_staging')
const MANIFEST_PATH = path.join(ROOT, 'resources', 'windows-transcription-manifest.json')
const PYTHON_ARCHIVE = path.join(
  ROOT,
  'vendor',
  'python-runtime',
  'cpython-3.11.15+20260414-x86_64-pc-windows-msvc-install_only.tar.gz'
)
const MODEL_CACHE_DIR = path.join(ROOT, '.benchmarks', 'faster-whisper-models')
const PARAKEET_MODEL_CACHE_DIR = path.join(ROOT, '.benchmarks', 'parakeet-models')
const SILERO_VAD_CACHE_DIR = path.join(ROOT, '.benchmarks', 'silero-vad-onnx')
const BUILD_ENV = {
  ...process.env,
  PYTHONDONTWRITEBYTECODE: '1',
  PIP_NO_COMPILE: '1',
  SOURCE_DATE_EPOCH: '1767225600'
}

const BOOTSTRAP_PACKAGES = ['pip==26.1.1', 'setuptools==82.0.1', 'wheel==0.47.0']
const CPU_RUNTIME_PACKAGES = [
  'annotated-doc==0.0.4',
  'anyio==4.13.0',
  'av==17.0.1',
  'certifi==2026.4.22',
  'click==8.3.3',
  'colorama==0.4.6',
  'ctranslate2==4.7.1',
  'faster-whisper==1.2.1',
  'filelock==3.29.0',
  'flatbuffers==25.12.19',
  'fsspec==2026.4.0',
  'h11==0.16.0',
  'hf-xet==1.5.0',
  'httpcore==1.0.9',
  'httpx==0.28.1',
  'huggingface_hub==1.14.0',
  'idna==3.13',
  'markdown-it-py==4.2.0',
  'mdurl==0.1.2',
  'numpy==2.4.4',
  'onnxruntime==1.25.1',
  'packaging==26.2',
  'protobuf==7.34.1',
  'Pygments==2.20.0',
  'PyYAML==6.0.3',
  'rich==15.0.0',
  'shellingham==1.5.4',
  'tokenizers==0.23.1',
  'tqdm==4.67.3',
  'typer==0.25.1',
  'typing_extensions==4.15.0'
]
const CUDA_PACKAGES = [
  'nvidia-cublas-cu12==12.9.2.10',
  'nvidia-cudnn-cu12==9.21.1.3',
  'nvidia-cuda-nvrtc-cu12==12.9.86'
]
const PARAKEET_RUNTIME_PACKAGES = [
  'numpy==2.4.4',
  'onnx-asr==0.11.0',
  'onnxruntime-directml==1.24.4'
]

const MODELS = [
  {
    id: 'distil-large-v3',
    repoId: 'Systran/faster-distil-whisper-large-v3',
    revision: 'c3058b475261292e64a0412df1d2681c06260fab',
    cacheDirName: 'models--Systran--faster-distil-whisper-large-v3',
    zipName: 'faster-whisper-distil-large-v3-ct2.zip'
  },
  {
    id: 'small.en',
    repoId: 'Systran/faster-whisper-small.en',
    revision: 'd1d751a5f8271d482d14ca55d9e2deeebbae577f',
    cacheDirName: 'models--Systran--faster-whisper-small.en',
    zipName: 'faster-whisper-small-en-ct2-int8.zip'
  }
]

const PARAKEET_MODELS = [
  {
    id: 'parakeet-tdt-0.6b-v3-fp32',
    repoId: 'istupakov/parakeet-tdt-0.6b-v3-onnx',
    revision: '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce',
    cacheDirName: 'models--istupakov--parakeet-tdt-0.6b-v3-onnx',
    zipName: 'parakeet-tdt-0.6b-v3-fp32.zip',
    files: [
      'encoder-model.onnx',
      'encoder-model.onnx.data',
      'decoder_joint-model.onnx',
      'vocab.txt',
      'config.json',
      'nemo128.onnx'
    ]
  },
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    repoId: 'istupakov/parakeet-tdt-0.6b-v3-onnx',
    revision: '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce',
    cacheDirName: 'models--istupakov--parakeet-tdt-0.6b-v3-onnx',
    zipName: 'parakeet-tdt-0.6b-v3-int8.zip',
    files: [
      'encoder-model.int8.onnx',
      'decoder_joint-model.int8.onnx',
      'vocab.txt',
      'config.json',
      'nemo128.onnx'
    ]
  }
]

const SILERO_VAD = {
  repoId: 'istupakov/silero-vad-onnx',
  revision: null,
  cacheDirName: 'models--istupakov--silero-vad-onnx',
  filename: 'silero_vad.onnx'
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Windows transcription assets must be prepared on Windows.')
  }

  const skipRuntime = process.argv.includes('--skip-runtime')
  const skipModels = process.argv.includes('--skip-models')

  await rm(STAGING_DIR, { recursive: true, force: true })
  await mkdir(STAGING_DIR, { recursive: true })
  await mkdir(OUT_DIR, { recursive: true })

  const artifacts = new Map()

  if (!skipRuntime) {
    artifacts.set(
      'faster-whisper-runtime-cpu-win-x64.zip',
      await prepareRuntime('cpu', 'faster-whisper-runtime-cpu-win-x64.zip', CPU_RUNTIME_PACKAGES)
    )
    artifacts.set(
      'faster-whisper-runtime-cuda-win-x64.zip',
      await prepareRuntime('cuda', 'faster-whisper-runtime-cuda-win-x64.zip', [
        ...CPU_RUNTIME_PACKAGES,
        ...CUDA_PACKAGES
      ])
    )
    artifacts.set(
      'parakeet-runtime-win-x64.zip',
      await prepareRuntime('parakeet', 'parakeet-runtime-win-x64.zip', PARAKEET_RUNTIME_PACKAGES)
    )
  }

  if (!skipModels) {
    for (const model of MODELS) {
      artifacts.set(model.zipName, await prepareModel(model))
    }
    for (const model of PARAKEET_MODELS) {
      artifacts.set(model.zipName, await prepareParakeetModel(model))
    }
  }

  await updateManifest(artifacts)
  await writeSummary(artifacts)
  console.log(`[windows-transcription-assets] Wrote assets to ${OUT_DIR}`)
}

async function prepareRuntime(kind, zipName, packages) {
  const runtimeDir = path.join(STAGING_DIR, `runtime-${kind}`)
  const extractDir = path.join(STAGING_DIR, `python-extract-${kind}`)
  const zipPath = path.join(OUT_DIR, zipName)

  await rm(runtimeDir, { recursive: true, force: true })
  await rm(extractDir, { recursive: true, force: true })
  await mkdir(runtimeDir, { recursive: true })
  await mkdir(extractDir, { recursive: true })

  run('tar', ['-xzf', PYTHON_ARCHIVE, '-C', extractDir])
  await cp(path.join(extractDir, 'python'), runtimeDir, { recursive: true })

  const pythonPath = path.join(runtimeDir, 'python.exe')
  run(pythonPath, ['-m', 'pip', 'install', '--no-compile', '--upgrade', ...BOOTSTRAP_PACKAGES])
  run(pythonPath, ['-m', 'pip', 'install', '--no-compile', ...packages])
  run(pythonPath, ['-m', 'pip', 'check'])

  await pruneRuntime(runtimeDir)
  await zipDirectory(runtimeDir, zipPath)
  return await describeArtifact(zipPath)
}

async function prepareModel(model) {
  const sourceDir = await resolveModelSnapshot(model)
  const stagingDir = path.join(STAGING_DIR, `model-${model.id}`)
  const zipPath = path.join(OUT_DIR, model.zipName)

  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  await cp(sourceDir, stagingDir, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.cache${path.sep}`)
  })
  await zipDirectory(stagingDir, zipPath)
  return await describeArtifact(zipPath)
}

async function prepareParakeetModel(model) {
  const sourceDir = await resolveParakeetModelSnapshot(model)
  const sileroVadPath = await resolveSileroVadSnapshot()
  const stagingDir = path.join(STAGING_DIR, `model-${model.id}`)
  const zipPath = path.join(OUT_DIR, model.zipName)

  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  for (const filename of model.files) {
    await cp(path.join(sourceDir, filename), path.join(stagingDir, filename))
  }
  await cp(sileroVadPath, path.join(stagingDir, SILERO_VAD.filename))

  await zipDirectory(stagingDir, zipPath)
  return await describeArtifact(zipPath)
}

async function resolveParakeetModelSnapshot(model) {
  const snapshotsDir = path.join(PARAKEET_MODEL_CACHE_DIR, model.cacheDirName, 'snapshots')
  if (model.revision) {
    const pinnedSnapshot = path.join(snapshotsDir, model.revision)
    if (await exists(pinnedSnapshot)) {
      return pinnedSnapshot
    }
  }

  const existing = await getNewestDirectory(snapshotsDir)
  if (existing && !model.revision) {
    return existing
  }

  const pythonPath = path.join(STAGING_DIR, 'runtime-parakeet', 'python.exe')
  if (!(await exists(pythonPath))) {
    throw new Error(
      `Parakeet runtime is required to download ${model.repoId}. Run without --skip-runtime.`
    )
  }

  run(pythonPath, [
    '-c',
    [
      'from huggingface_hub import snapshot_download',
      `snapshot_download(repo_id=${JSON.stringify(model.repoId)}, revision=${JSON.stringify(model.revision)}, cache_dir=${JSON.stringify(PARAKEET_MODEL_CACHE_DIR)})`
    ].join('; ')
  ])

  const downloaded = model.revision
    ? path.join(snapshotsDir, model.revision)
    : await getNewestDirectory(snapshotsDir)
  if (!downloaded || !(await exists(downloaded))) {
    throw new Error(`Could not locate downloaded snapshot for ${model.repoId}.`)
  }

  return downloaded
}

async function resolveSileroVadSnapshot() {
  const snapshotsDir = path.join(SILERO_VAD_CACHE_DIR, SILERO_VAD.cacheDirName, 'snapshots')
  const existing = await getNewestDirectory(snapshotsDir)
  if (existing) {
    const candidate = path.join(existing, SILERO_VAD.filename)
    if (await exists(candidate)) {
      return candidate
    }
  }

  const pythonPath = path.join(STAGING_DIR, 'runtime-parakeet', 'python.exe')
  if (!(await exists(pythonPath))) {
    throw new Error('Parakeet runtime is required to download silero VAD. Run without --skip-runtime.')
  }

  run(pythonPath, [
    '-c',
    [
      'from huggingface_hub import hf_hub_download',
      `print(hf_hub_download(repo_id=${JSON.stringify(SILERO_VAD.repoId)}, filename=${JSON.stringify(SILERO_VAD.filename)}, cache_dir=${JSON.stringify(SILERO_VAD_CACHE_DIR)}))`
    ].join('; ')
  ])

  const downloaded = await getNewestDirectory(snapshotsDir)
  if (!downloaded) {
    throw new Error(`Could not locate downloaded silero VAD snapshot for ${SILERO_VAD.repoId}.`)
  }

  const candidate = path.join(downloaded, SILERO_VAD.filename)
  if (!(await exists(candidate))) {
    throw new Error(`Downloaded silero VAD is missing ${SILERO_VAD.filename}.`)
  }

  return candidate
}

async function resolveModelSnapshot(model) {
  const snapshotsDir = path.join(MODEL_CACHE_DIR, model.cacheDirName, 'snapshots')
  if (model.revision) {
    const pinnedSnapshot = path.join(snapshotsDir, model.revision)
    if (await exists(pinnedSnapshot)) {
      return pinnedSnapshot
    }
  }

  const existing = await getNewestDirectory(snapshotsDir)
  if (existing && !model.revision) {
    return existing
  }

  const pythonPath = path.join(STAGING_DIR, 'runtime-cpu', 'python.exe')
  if (!(await exists(pythonPath))) {
    throw new Error(
      `CPU runtime is required to download ${model.repoId}. Run without --skip-runtime.`
    )
  }

  run(pythonPath, [
    '-c',
    [
      'from huggingface_hub import snapshot_download',
      'import sys',
      `snapshot_download(repo_id=${JSON.stringify(model.repoId)}, revision=${JSON.stringify(model.revision)}, cache_dir=${JSON.stringify(MODEL_CACHE_DIR)})`
    ].join('; ')
  ])

  const downloaded = model.revision
    ? path.join(snapshotsDir, model.revision)
    : await getNewestDirectory(snapshotsDir)
  if (!downloaded || !(await exists(downloaded))) {
    throw new Error(`Could not locate downloaded snapshot for ${model.repoId}.`)
  }

  return downloaded
}

async function getNewestDirectory(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true })
    const dirs = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = path.join(parent, entry.name)
      const info = await stat(fullPath)
      dirs.push({ path: fullPath, mtimeMs: info.mtimeMs })
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return dirs[0]?.path ?? null
  } catch {
    return null
  }
}

async function pruneRuntime(runtimeDir) {
  const patterns = [
    '__pycache__',
    'tests',
    'test',
    '.pytest_cache',
    'pip/_vendor/cachecontrol/caches',
    'Scripts',
    'pip',
    'setuptools',
    'wheel'
  ]

  await removeMatching(runtimeDir, (fullPath, name) => {
    if (patterns.includes(name)) return true
    const normalizedPath = fullPath.replaceAll(path.sep, '/')
    return (
      name.endsWith('.pyc') ||
      name.endsWith('.pyo') ||
      name === 'RECORD' ||
      name === 'RECORD.jws' ||
      name === 'RECORD.p7s' ||
      name === 'direct_url.json' ||
      normalizedPath.endsWith('.dist-info/REQUESTED') ||
      normalizedPath.endsWith('.dist-info/entry_points.txt') ||
      /\/(pip|setuptools|wheel)-[^/]+\.dist-info$/.test(normalizedPath)
    )
  })
}

async function removeMatching(dir, shouldRemove) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (shouldRemove(fullPath, entry.name)) {
      await rm(fullPath, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) {
      await removeMatching(fullPath, shouldRemove)
    }
  }
}

async function zipDirectory(sourceDir, zipPath) {
  await rm(zipPath, { force: true })
  const escapedSource = sourceDir.replace(/'/g, "''")
  const escapedZipPath = zipPath.replace(/'/g, "''")
  const command = [
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$source = [System.IO.Path]::GetFullPath('${escapedSource}')`,
    `$destination = [System.IO.Path]::GetFullPath('${escapedZipPath}')`,
    'if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }',
    '$fixedTime = [DateTimeOffset]::Parse("2026-01-01T00:00:00Z")',
    '$compression = [System.IO.Compression.CompressionLevel]::Optimal',
    '$zip = [System.IO.Compression.ZipFile]::Open($destination, [System.IO.Compression.ZipArchiveMode]::Create)',
    'try {',
    '  $files = Get-ChildItem -LiteralPath $source -Recurse -File | Sort-Object FullName',
    '  foreach ($file in $files) {',
    '    $relative = $file.FullName.Substring($source.Length).TrimStart("\\", "/").Replace("\\", "/")',
    '    $entry = $zip.CreateEntry($relative, $compression)',
    '    $entry.LastWriteTime = $fixedTime',
    '    $inputStream = [System.IO.File]::OpenRead($file.FullName)',
    '    $outputStream = $entry.Open()',
    '    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }',
    '  }',
    '} finally {',
    '  $zip.Dispose()',
    '}'
  ].join('; ')
  run('powershell', ['-NoProfile', '-Command', command])
}

async function describeArtifact(filePath) {
  const info = await stat(filePath)
  return {
    filePath,
    filename: path.basename(filePath),
    bytes: info.size,
    sha256: await hashFile(filePath)
  }
}

async function updateManifest(artifacts) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  for (const profile of manifest.profiles ?? []) {
    for (const asset of profile.assets ?? []) {
      const artifact = artifacts.get(asset.filename)
      if (!artifact) continue
      asset.sha256 = artifact.sha256
      asset.bytes = artifact.bytes
    }
  }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function writeSummary(artifacts) {
  const lines = ['# Windows transcription assets', '']
  for (const artifact of artifacts.values()) {
    lines.push(`- ${artifact.filename}`)
    lines.push(`  - bytes: ${artifact.bytes}`)
    lines.push(`  - sha256: ${artifact.sha256}`)
  }
  await writeFile(path.join(OUT_DIR, 'SHA256SUMS.md'), `${lines.join('\n')}\n`)
}

function run(command, args) {
  console.log(`[windows-transcription-assets] ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: BUILD_ENV
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`)
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

main().catch((error) => {
  console.error('[windows-transcription-assets] Failed')
  console.error(error)
  process.exitCode = 1
})
