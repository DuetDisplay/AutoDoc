const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { createReadStream, createWriteStream } = require('node:fs')
const { open } = require('node:fs/promises')
const { cp, mkdir, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const ROOT = process.cwd()
const RELEASE_TAG =
  process.env.AUTODOC_WINDOWS_TRANSCRIPTION_RELEASE_TAG ?? 'windows-transcription-v3'
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
const CANARY_MODEL_CACHE_DIR = path.join(ROOT, '.benchmarks', 'canary-models')
const WHISPER_TURBO_MODEL_CACHE_DIR = path.join(ROOT, '.benchmarks', 'whisper-turbo-models')
const BUILD_ENV = {
  ...process.env,
  PYTHONDONTWRITEBYTECODE: '1',
  PIP_NO_COMPILE: '1',
  SOURCE_DATE_EPOCH: '1767225600'
}
for (const key of Object.keys(BUILD_ENV)) {
  if (key.toLowerCase() === 'psmodulepath') {
    delete BUILD_ENV[key]
  }
}

const BOOTSTRAP_PACKAGES = ['pip==26.1.1', 'setuptools==82.0.1', 'wheel==0.47.0']
const CPU_RUNTIME_PACKAGES = [
  'annotated-doc==0.0.4',
  'anyio==4.13.0',
  'certifi==2026.4.22',
  'click==8.3.3',
  'colorama==0.4.6',
  'ctranslate2==4.7.1',
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
  'flatbuffers==25.12.19',
  'mpmath==1.3.0',
  'numpy==2.4.4',
  'onnx-asr==0.11.0',
  'onnxruntime-directml==1.24.4',
  'packaging==26.2',
  'protobuf==7.35.1',
  'sympy==1.14.0'
]
const CANARY_CUDA_RUNTIME_PACKAGES = [
  'flatbuffers==25.12.19',
  'numpy==2.4.4',
  'nvidia-cuda-runtime-cu12==12.9.79',
  'nvidia-cufft-cu12==11.4.1.4',
  'nvidia-curand-cu12==10.3.10.19',
  'nvidia-nvjitlink-cu12==12.9.86',
  'onnx-asr==0.11.0',
  'onnxruntime-gpu==1.25.1',
  'packaging==26.2',
  'protobuf==7.35.1',
  ...CUDA_PACKAGES
]
const ONNX_TOOL_PACKAGES = [
  'ml_dtypes==0.6.0',
  'numpy==2.4.6',
  'onnx==1.23.1',
  'packaging==26.2',
  'protobuf==7.36.2',
  'typing_extensions==4.16.0'
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
  revision: 'b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6',
  sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
  cacheDirName: 'models--istupakov--silero-vad-onnx',
  filename: 'silero_vad.onnx'
}

const CANARY = {
  repoId: 'istupakov/canary-1b-v2-onnx',
  revision: '5ebc1520cef7b6b318b3526ad17adbfe00bc1bfc',
  cacheDir: CANARY_MODEL_CACHE_DIR
}
const CANARY_SHARED_FILES = {
  'vocab.txt': '2c9efe6104fd29522ea27ce0e3aef5d37c690af4e5a4232e643e23ca403ffea3',
  'config.json': 'f90ace8e35326dcd47c7330b230644fa0835083ed1e89e2f59aa08ba10d74f54'
}

const HF_FILE_MODELS = [
  {
    ...CANARY,
    zipName: 'canary-1b-v2-int8.zip',
    sileroVad: true,
    files: {
      'encoder-model.int8.onnx': '6d96e9945898e5ace48f4efecd459ca1df81859730be27b8af6b197639403ee1',
      'decoder-model.int8.onnx': '52d83aa7aad41fbbe4f9dfcd341d784735a6eb4c6eb0d3290fc27a0d8ac39abf',
      ...CANARY_SHARED_FILES
    }
  },
  {
    ...CANARY,
    zipName: 'canary-1b-v2-fp32.zip',
    sileroVad: true,
    files: {
      'encoder-model.onnx': 'c8352f7adf033ad4dfcdc42e665eaacb1ee93e1acf6b168e4f1dfc57c26b0195',
      'encoder-model.onnx.data': 'a1711a0b88dc1bda0ff94178f2f8c66b1450990599856982ddc8cc6e155384ec',
      'decoder-model.onnx': '962dc77709f31c1ed8a55a7518ff4bed7316a87c442e7c79aa3573c4bbc39a72',
      ...CANARY_SHARED_FILES
    },
    allowzeroRewrite: {
      filename: 'encoder-model.onnx',
      sha256: '52fa8e6bd54d79435e3c4d2d1e2c7367fd9c3a18523fd081274d2fffa1743363'
    }
  },
  {
    repoId: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    revision: '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
    cacheDir: WHISPER_TURBO_MODEL_CACHE_DIR,
    zipName: 'faster-whisper-large-v3-turbo-ct2.zip',
    files: {
      'model.bin': 'e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da',
      'config.json': 'b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e',
      'tokenizer.json': '297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd',
      'vocabulary.json': 'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1',
      'preprocessor_config.json': '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711'
    }
  },
  {
    repoId: 'ggerganov/whisper.cpp',
    revision: '5359861c739e955e79d9a303bcbc70fb988958b1',
    cacheDir: WHISPER_TURBO_MODEL_CACHE_DIR,
    zipName: 'ggml-large-v3-turbo.zip',
    files: {
      'ggml-large-v3-turbo.bin': '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'
    }
  }
]

const WHISPER_CPP_TAG = 'v1.9.4'
const WHISPER_CPP_COMMIT = '927cfce34f31707e17f2bff35c349632fb9e2c3a'
const WHISPER_CPP_PATCH_NAME = 'whisper-dtw-median-filter-short-window.patch'
const WHISPER_CPP_VULKAN_FILES = [
  'BUILD.txt',
  'ggml-base.dll',
  'ggml-cpu.dll',
  'ggml-vulkan.dll',
  'ggml.dll',
  'whisper-cli.exe',
  'whisper.dll'
]

const MAX_RELEASE_PART_BYTES = 2_000_000_000

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
    const fasterWhisperOptions = {
      noDepsPackages: ['faster-whisper==1.2.1'],
      allowedPipCheckLines: ['faster-whisper 1.2.1 requires av, which is not installed.']
    }
    artifacts.set(
      'faster-whisper-runtime-cpu-win-x64-v3.zip',
      await prepareRuntime(
        'cpu',
        'faster-whisper-runtime-cpu-win-x64-v3.zip',
        CPU_RUNTIME_PACKAGES,
        fasterWhisperOptions
      )
    )
    artifacts.set(
      'faster-whisper-runtime-cuda-win-x64-v3.zip',
      await prepareRuntime(
        'cuda',
        'faster-whisper-runtime-cuda-win-x64-v3.zip',
        [...CPU_RUNTIME_PACKAGES, ...CUDA_PACKAGES],
        fasterWhisperOptions
      )
    )
    artifacts.set(
      'parakeet-runtime-win-x64-v3.zip',
      await prepareRuntime('parakeet', 'parakeet-runtime-win-x64-v3.zip', PARAKEET_RUNTIME_PACKAGES)
    )
    artifacts.set(
      'canary-cuda-runtime-win-x64.zip',
      await prepareRuntime(
        'canary-cuda',
        'canary-cuda-runtime-win-x64.zip',
        CANARY_CUDA_RUNTIME_PACKAGES,
        {
          beforeZip: async (runtimeDir) => {
            await cp(
              path.join(ROOT, 'scripts', 'canary-cuda-sitecustomize.py'),
              path.join(runtimeDir, 'Lib', 'site-packages', 'sitecustomize.py')
            )
            const tensorrtDll = path.join(
              runtimeDir,
              'Lib',
              'site-packages',
              'onnxruntime',
              'capi',
              'onnxruntime_providers_tensorrt.dll'
            )
            if (!(await exists(tensorrtDll))) {
              throw new Error(
                'Expected onnxruntime_providers_tensorrt.dll in the canary-cuda runtime, but it was not there.'
              )
            }
            await rm(tensorrtDll)
          }
        }
      )
    )
    artifacts.set('whisper-cpp-vulkan-runtime-win-x64.zip', await prepareWhisperCppVulkanRuntime())
  }

  if (!skipModels) {
    for (const model of MODELS) {
      artifacts.set(model.zipName, await prepareModel(model))
    }
    for (const model of PARAKEET_MODELS) {
      artifacts.set(model.zipName, await prepareParakeetModel(model))
    }
    for (const model of HF_FILE_MODELS) {
      artifacts.set(model.zipName, await prepareHfFileModel(model))
    }
  }

  await writeSummary(artifacts)
  console.log(`[windows-transcription-assets] Wrote assets to ${OUT_DIR}`)
}

async function preparePythonEnv(envDir, packages, options = {}) {
  const { noDepsPackages = [], allowedPipCheckLines = [] } = options
  const extractDir = path.join(
    STAGING_DIR,
    `python-extract-${path.basename(envDir).replace(/^runtime-/, '')}`
  )

  await rm(envDir, { recursive: true, force: true })
  await rm(extractDir, { recursive: true, force: true })
  await mkdir(envDir, { recursive: true })
  await mkdir(extractDir, { recursive: true })

  run('tar', ['-xzf', PYTHON_ARCHIVE, '-C', extractDir])
  await cp(path.join(extractDir, 'python'), envDir, { recursive: true })

  const pythonPath = path.join(envDir, 'python.exe')
  run(pythonPath, ['-m', 'pip', 'install', '--no-compile', '--upgrade', ...BOOTSTRAP_PACKAGES])
  run(pythonPath, ['-m', 'pip', 'install', '--no-compile', ...packages])
  if (noDepsPackages.length) {
    run(pythonPath, ['-m', 'pip', 'install', '--no-compile', '--no-deps', ...noDepsPackages])
  }
  checkPip(pythonPath, allowedPipCheckLines)
  assertPinnedRuntime(pythonPath, [...packages, ...noDepsPackages])
  return pythonPath
}

async function prepareRuntime(kind, zipName, packages, options = {}) {
  const { beforeZip } = options
  const runtimeDir = path.join(STAGING_DIR, `runtime-${kind}`)
  const zipPath = path.join(OUT_DIR, zipName)

  await preparePythonEnv(runtimeDir, packages, options)

  await pruneRuntime(runtimeDir)
  if (beforeZip) await beforeZip(runtimeDir)
  await zipDirectory(runtimeDir, zipPath)
  return await describeArtifact(zipPath, zipName)
}

async function getOnnxToolsPython() {
  const pythonPath = path.join(STAGING_DIR, 'tools-onnx', 'python.exe')
  if (!(await exists(pythonPath))) {
    await preparePythonEnv(path.join(STAGING_DIR, 'tools-onnx'), ONNX_TOOL_PACKAGES)
  }
  return pythonPath
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
  const artifact = await describeArtifact(zipPath, model.zipName)
  await rm(stagingDir, { recursive: true, force: true })
  return artifact
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
  const artifact = await describeArtifact(zipPath, model.zipName)
  await rm(stagingDir, { recursive: true, force: true })
  return artifact
}

async function prepareHfFileModel(model) {
  const { files, allowzeroRewrite } = model
  const sourceDir = await downloadHfFiles(model)
  const stagingDir = path.join(STAGING_DIR, `model-${path.basename(model.zipName, '.zip')}`)
  const zipPath = path.join(OUT_DIR, model.zipName)

  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  for (const filename of Object.keys(files)) {
    if (filename === allowzeroRewrite?.filename) continue
    await cp(path.join(sourceDir, filename), path.join(stagingDir, filename))
  }
  if (allowzeroRewrite) {
    const rewritten = path.join(stagingDir, allowzeroRewrite.filename)
    run(await getOnnxToolsPython(), [
      path.join(ROOT, 'scripts', 'canary-allowzero-rewrite.py'),
      path.join(sourceDir, allowzeroRewrite.filename),
      rewritten
    ])
    const actual = await hashFile(rewritten)
    if (actual !== allowzeroRewrite.sha256) {
      throw new Error(
        `Rewritten ${allowzeroRewrite.filename}: expected ${allowzeroRewrite.sha256}, got ${actual}`
      )
    }
  }
  if (model.sileroVad) {
    await cp(await resolveSileroVadSnapshot(), path.join(stagingDir, SILERO_VAD.filename))
  }

  await zipDirectory(stagingDir, zipPath)
  const artifact = await describeArtifact(zipPath, model.zipName)
  await rm(stagingDir, { recursive: true, force: true })
  return artifact
}

async function prepareWhisperCppVulkanRuntime() {
  const vulkanSdk = process.env.VULKAN_SDK
  if (!vulkanSdk || !(await exists(vulkanSdk))) {
    throw new Error(
      `VULKAN_SDK must point at an existing Vulkan SDK directory (got ${vulkanSdk ?? 'unset'}).`
    )
  }

  // The Vulkan shader-generator build nests deep enough to pass MAX_PATH under STAGING_DIR.
  const srcDir = path.join(os.tmpdir(), 'autodoc-whisper.cpp')
  const zipName = 'whisper-cpp-vulkan-runtime-win-x64.zip'
  const zipPath = path.join(OUT_DIR, zipName)
  const patchPath = path.join(ROOT, 'scripts', 'whisper-cpp', WHISPER_CPP_PATCH_NAME)

  await rm(srcDir, { recursive: true, force: true })
  run('git', [
    '-c',
    'core.autocrlf=false',
    'clone',
    '--depth',
    '1',
    '--branch',
    WHISPER_CPP_TAG,
    'https://github.com/ggml-org/whisper.cpp',
    srcDir
  ])

  const head = runCapture('git', ['-C', srcDir, 'rev-parse', 'HEAD']).trim()
  if (head !== WHISPER_CPP_COMMIT) {
    throw new Error(`whisper.cpp HEAD expected ${WHISPER_CPP_COMMIT}, got ${head}`)
  }

  run('git', ['-C', srcDir, 'apply', patchPath])

  const buildDir = path.join(srcDir, 'build')
  const configureArgs = [
    '-S',
    srcDir,
    '-B',
    buildDir,
    '-G',
    'Visual Studio 17 2022',
    '-A',
    'x64',
    '-DGGML_VULKAN=ON',
    '-DWHISPER_BUILD_EXAMPLES=ON'
  ]
  const buildArgs = ['--build', buildDir, '--config', 'Release', '--target', 'whisper-cli']
  run('cmake', configureArgs)
  run('cmake', buildArgs)

  const releaseDir = path.join(buildDir, 'bin', 'Release')
  const stagingDir = path.join(STAGING_DIR, 'whisper-cpp-vulkan-runtime')
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  await cp(path.join(releaseDir, 'whisper-cli.exe'), path.join(stagingDir, 'whisper-cli.exe'))
  for (const name of await readdir(releaseDir)) {
    if (name.endsWith('.dll')) {
      await cp(path.join(releaseDir, name), path.join(stagingDir, name))
    }
  }

  const cmakeVersionLine = runCapture('cmake', ['--version']).split(/\r?\n/)[0]
  const patchText = await readFile(patchPath)
  const buildTxt = [
    'whisper.cpp Vulkan Windows runtime for AutoDoc',
    '',
    `Tag: ${WHISPER_CPP_TAG}`,
    `Commit: ${WHISPER_CPP_COMMIT} (ggml-org/whisper.cpp)`,
    `Patch applied: ${WHISPER_CPP_PATCH_NAME}`,
    `cmake ${configureArgs.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`,
    `cmake ${buildArgs.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`,
    'Toolchain:',
    cmakeVersionLine,
    `Vulkan SDK: ${path.basename(vulkanSdk)}`,
    '===== PATCH DIFF =====',
    ''
  ].join('\n')
  await writeFile(
    path.join(stagingDir, 'BUILD.txt'),
    Buffer.concat([Buffer.from(buildTxt), patchText])
  )

  const staged = (await readdir(stagingDir)).sort()
  const expected = [...WHISPER_CPP_VULKAN_FILES].sort()
  const missing = expected.filter((name) => !staged.includes(name))
  const unexpected = staged.filter((name) => !expected.includes(name))
  if (missing.length || unexpected.length) {
    throw new Error(
      `whisper.cpp Vulkan runtime staged files differ: missing [${missing.join(', ')}]; unexpected [${unexpected.join(', ')}]`
    )
  }

  await zipDirectory(stagingDir, zipPath)
  const artifact = await describeArtifact(zipPath, zipName)
  await rm(stagingDir, { recursive: true, force: true })
  await rm(srcDir, { recursive: true, force: true })
  return artifact
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

async function downloadHfFiles(source) {
  const { repoId, revision, cacheDir, files } = source
  const snapshotDir = path.join(
    cacheDir,
    `models--${repoId.replaceAll('/', '--')}`,
    'snapshots',
    revision
  )

  const missing = []
  for (const filename of Object.keys(files)) {
    if (!(await exists(path.join(snapshotDir, filename)))) {
      missing.push(filename)
    }
  }

  if (missing.length) {
    const pythonPath = path.join(STAGING_DIR, 'runtime-cpu', 'python.exe')
    if (!(await exists(pythonPath))) {
      throw new Error(`CPU runtime is required to download ${repoId}. Run without --skip-runtime.`)
    }

    run(pythonPath, [
      '-c',
      [
        'from huggingface_hub import hf_hub_download',
        ...missing.map(
          (filename) =>
            `hf_hub_download(repo_id=${JSON.stringify(repoId)}, filename=${JSON.stringify(filename)}, revision=${JSON.stringify(revision)}, cache_dir=${JSON.stringify(cacheDir)})`
        )
      ].join('; ')
    ])
  }

  for (const [filename, expected] of Object.entries(files)) {
    const filePath = path.join(snapshotDir, filename)
    const actual = await hashFile(filePath)
    if (actual !== expected) {
      throw new Error(`${repoId}@${revision} ${filename}: expected ${expected}, got ${actual}`)
    }
  }

  return snapshotDir
}

async function resolveSileroVadSnapshot() {
  const snapshotDir = await downloadHfFiles({
    repoId: SILERO_VAD.repoId,
    revision: SILERO_VAD.revision,
    cacheDir: SILERO_VAD_CACHE_DIR,
    files: { [SILERO_VAD.filename]: SILERO_VAD.sha256 }
  })
  return path.join(snapshotDir, SILERO_VAD.filename)
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

async function describeArtifact(filePath, zipName = path.basename(filePath)) {
  const info = await stat(filePath)
  const artifact = {
    filePath,
    filename: path.basename(filePath),
    bytes: info.size,
    sha256: await hashFile(filePath)
  }

  if (info.size <= MAX_RELEASE_PART_BYTES) {
    return artifact
  }

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const artifactBaseUrl = (manifest.artifactBaseUrl ?? '').replace(/\/$/, '')
  const parts = []
  const handle = await open(filePath, 'r')
  const partCount = Math.ceil(info.size / MAX_RELEASE_PART_BYTES)
  const partSize = Math.ceil(info.size / partCount)
  let offset = 0
  let partIndex = 1

  try {
    while (offset < info.size) {
      const partBytes = Math.min(partSize, info.size - offset)
      const partFilename = `${zipName}.part${partIndex}`
      const partPath = path.join(OUT_DIR, partFilename)
      const writeStream = createWriteStream(partPath)
      let written = 0

      while (written < partBytes) {
        const chunkSize = Math.min(8 * 1024 * 1024, partBytes - written)
        const buffer = Buffer.allocUnsafe(chunkSize)
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, offset + written)
        if (bytesRead <= 0) {
          throw new Error(
            `Unexpected EOF while splitting ${zipName} at offset ${offset + written}.`
          )
        }
        if (!writeStream.write(buffer.subarray(0, bytesRead))) {
          await new Promise((resolve, reject) => {
            writeStream.once('drain', resolve)
            writeStream.once('error', reject)
          })
        }
        written += bytesRead
      }

      await new Promise((resolve, reject) => {
        writeStream.end(resolve)
        writeStream.once('error', reject)
      })

      const partInfo = await describeArtifact(partPath)
      parts.push({
        filename: partFilename,
        url: `${artifactBaseUrl}/${partFilename}`,
        sha256: partInfo.sha256,
        bytes: partInfo.bytes
      })
      offset += partBytes
      partIndex += 1
    }
  } finally {
    await handle.close()
  }

  return {
    ...artifact,
    parts
  }
}

async function writeSummary(artifacts) {
  const lines = ['# Windows transcription assets', '']
  for (const artifact of artifacts.values()) {
    lines.push(`- ${artifact.filename}`)
    lines.push(`  - bytes: ${artifact.bytes}`)
    lines.push(`  - sha256: ${artifact.sha256}`)
    for (const part of artifact.parts ?? []) {
      lines.push(`  - part: ${part.filename}`)
      lines.push(`    - bytes: ${part.bytes}`)
      lines.push(`    - sha256: ${part.sha256}`)
    }
  }
  await writeFile(path.join(OUT_DIR, 'SHA256SUMS.md'), `${lines.join('\n')}\n`)
}

function distName(spec) {
  return spec.split('==')[0].toLowerCase().replace(/[_.]/g, '-')
}

function checkPip(pythonPath, allowedLines) {
  if (!allowedLines.length) {
    run(pythonPath, ['-m', 'pip', 'check'])
    return
  }

  const args = ['-m', 'pip', 'check']
  console.log(`[windows-transcription-assets] ${pythonPath} ${args.join(' ')}`)
  const result = spawnSync(pythonPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: BUILD_ENV
  })
  if (result.error) {
    throw result.error
  }
  if (result.status === 0) return
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (
    lines.length === allowedLines.length &&
    lines.every((line, index) => line === allowedLines[index])
  ) {
    return
  }
  process.stdout.write(output)
  throw new Error(`pip check exited with code ${result.status}`)
}

function assertPinnedRuntime(pythonPath, packages) {
  const args = ['-m', 'pip', 'list', '--format=freeze']
  const result = spawnSync(pythonPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: BUILD_ENV
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    throw new Error(`pip list exited with code ${result.status}`)
  }

  const pins = new Map(packages.map((spec) => [distName(spec), spec.split('==')[1]]))
  for (const line of result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const name = distName(line)
    const version = line.split('==')[1]
    if (name === 'pip' || name === 'setuptools' || name === 'wheel') continue
    const pinned = pins.get(name)
    if (!pinned) {
      throw new Error(`Unpinned distribution leaked into runtime: ${line}`)
    }
    if (pinned !== version) {
      throw new Error(`Pinned ${name}==${pinned} but installed ${line}`)
    }
    pins.delete(name)
  }
  if (pins.size) {
    throw new Error(
      `Pinned packages missing from runtime: ${[...pins.entries()]
        .map(([name, version]) => `${name}==${version}`)
        .join(', ')}`
    )
  }
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

function runCapture(command, args) {
  console.log(`[windows-transcription-assets] ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: BUILD_ENV
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    throw new Error(`${command} exited with code ${result.status}`)
  }
  return result.stdout ?? ''
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
