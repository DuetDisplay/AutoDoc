#!/usr/bin/env node

const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createReadStream } = require('node:fs')
const {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} = require('node:fs/promises')
const path = require('node:path')

const ROOT = process.cwd()
const ARCH = process.arch
const OUT_DIR = path.join(ROOT, 'resources', 'macos-whisper-runtime', 'arm64')
const REQUIRED_FILES = [
  'whisper-cpp',
  'libwhisper.1.dylib',
  'libggml.0.dylib',
  'libggml-base.0.dylib'
]

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    ...options
  })
}

function brewPrefix(formula, envName) {
  if (process.env[envName]) {
    return process.env[envName]
  }

  try {
    return run('brew', ['--prefix', formula]).trim()
  } catch {
    throw new Error(
      `Missing Homebrew formula "${formula}". Install it or set ${envName} to the package prefix.`
    )
  }
}

async function copyRuntimeFile(source, destinationName) {
  const destination = path.join(OUT_DIR, destinationName)
  await copyFile(source, destination)
  await chmod(destination, 0o755)
  return destination
}

async function copyMatchingFiles(sourceDir, pattern) {
  const copied = []
  const entries = await readdir(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) {
      continue
    }

    copied.push(await copyRuntimeFile(path.join(sourceDir, entry.name), entry.name))
  }

  return copied
}

async function removeAppleDoubleFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.name.startsWith('._')) {
      await rm(entryPath, { recursive: entry.isDirectory(), force: true })
      continue
    }
    if (entry.isDirectory()) {
      await removeAppleDoubleFiles(entryPath)
    }
  }
}

function listDependencies(filePath) {
  const output = run('otool', ['-L', filePath])
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter(Boolean)
}

function isManagedRuntimeDependency(dependencyPath) {
  const dependencyName = path.basename(dependencyPath)
  return /^(?:libwhisper|libggml|libomp)/.test(dependencyName)
}

function rewriteRuntimeLinks(filePath, localPrefix) {
  const fileName = path.basename(filePath)

  if (fileName.endsWith('.dylib')) {
    run('install_name_tool', ['-id', `@loader_path/${fileName}`, filePath], { stdio: 'inherit' })
  }

  for (const dependency of listDependencies(filePath)) {
    if (fileName.endsWith('.dylib') && path.basename(dependency) === fileName) {
      continue
    }

    if (!isManagedRuntimeDependency(dependency)) {
      continue
    }

    const localDependency = `${localPrefix}/${path.basename(dependency)}`
    if (dependency !== localDependency) {
      run('install_name_tool', ['-change', dependency, localDependency, filePath], {
        stdio: 'inherit'
      })
    }
  }
}

async function replaceBinaryString(filePath, searchValue, replacementValue) {
  const search = Buffer.from(searchValue)
  const replacement = Buffer.from(replacementValue)

  if (replacement.length > search.length) {
    throw new Error(
      `Cannot replace ${searchValue} with longer value ${replacementValue} in ${path.basename(
        filePath
      )}`
    )
  }

  const file = await readFile(filePath)
  let offset = file.indexOf(search)
  let replacements = 0

  while (offset !== -1) {
    replacement.copy(file, offset)
    file.fill(0, offset + replacement.length, offset + search.length)
    replacements += 1
    offset = file.indexOf(search, offset + search.length)
  }

  if (replacements > 0) {
    await writeFile(filePath, file)
  }
}

async function rewriteCompiledBackendSearchPaths(filePath) {
  const backendDirs = run('strings', [filePath])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('/opt/homebrew/') && line.endsWith('/libexec'))

  for (const backendDir of backendDirs) {
    await replaceBinaryString(filePath, backendDir, '@executable_path')
  }
}

function verifyRuntimeLinks(filePath) {
  const dependencies = listDependencies(filePath)
  const forbidden = dependencies.filter(
    (dependency) =>
      dependency.includes('/opt/homebrew/') ||
      /^@rpath\/(?:libwhisper|libggml|libomp)/.test(dependency)
  )

  if (forbidden.length > 0) {
    throw new Error(
      `Runtime file ${path.basename(filePath)} still has non-portable dependencies:\n${forbidden.join(
        '\n'
      )}`
    )
  }
}

function verifyPortableBinaryStrings(filePath) {
  const forbidden = run('strings', [filePath])
    .split(/\r?\n/)
    .filter((line) => line.includes('/opt/homebrew/'))

  if (forbidden.length > 0) {
    throw new Error(
      `Runtime file ${path.basename(filePath)} still embeds Homebrew paths:\n${forbidden.join(
        '\n'
      )}`
    )
  }
}

function adHocSign(filePath) {
  run('codesign', ['--force', '--sign', '-', filePath], { stdio: 'inherit' })
}

async function hashFile(filePath) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('[macos-whisper-runtime] Skipping: host is not macOS.')
    return
  }

  if (ARCH !== 'arm64') {
    throw new Error(`macOS Whisper runtime packaging is currently arm64-only. Host arch: ${ARCH}`)
  }

  const whisperPrefix = brewPrefix('whisper-cpp', 'AUTODOC_MACOS_WHISPER_CPP_PREFIX')
  const ggmlPrefix = brewPrefix('ggml', 'AUTODOC_MACOS_GGML_PREFIX')
  const libompPrefix = brewPrefix('libomp', 'AUTODOC_MACOS_LIBOMP_PREFIX')

  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const runtimeFiles = [
    await copyRuntimeFile(path.join(whisperPrefix, 'bin', 'whisper-cli'), 'whisper-cpp'),
    await copyRuntimeFile(
      path.join(whisperPrefix, 'lib', 'libwhisper.1.dylib'),
      'libwhisper.1.dylib'
    ),
    await copyRuntimeFile(path.join(ggmlPrefix, 'lib', 'libggml.0.dylib'), 'libggml.0.dylib'),
    await copyRuntimeFile(
      path.join(ggmlPrefix, 'lib', 'libggml-base.0.dylib'),
      'libggml-base.0.dylib'
    ),
    await copyRuntimeFile(path.join(libompPrefix, 'lib', 'libomp.dylib'), 'libomp.dylib'),
    ...(await copyMatchingFiles(path.join(ggmlPrefix, 'libexec'), /^libggml.*\.so$/i))
  ]

  for (const requiredFile of REQUIRED_FILES) {
    await stat(path.join(OUT_DIR, requiredFile))
  }

  for (const runtimeFile of runtimeFiles) {
    const localPrefix =
      path.basename(runtimeFile) === 'whisper-cpp' ? '@executable_path' : '@loader_path'
    rewriteRuntimeLinks(runtimeFile, localPrefix)
    await rewriteCompiledBackendSearchPaths(runtimeFile)
  }

  for (const runtimeFile of runtimeFiles) {
    adHocSign(runtimeFile)
    verifyRuntimeLinks(runtimeFile)
    verifyPortableBinaryStrings(runtimeFile)
  }

  await removeAppleDoubleFiles(path.dirname(OUT_DIR))

  run(path.join(OUT_DIR, 'whisper-cpp'), ['--help'], { stdio: 'ignore' })

  const totalBytes = (
    await Promise.all(runtimeFiles.map(async (filePath) => (await stat(filePath)).size))
  ).reduce((sum, size) => sum + size, 0)
  const archiveHash = await hashFile(path.join(OUT_DIR, 'whisper-cpp'))

  console.log(`[macos-whisper-runtime] Prepared arm64 runtime in ${OUT_DIR}`)
  console.log(`[macos-whisper-runtime] Runtime files: ${runtimeFiles.length}`)
  console.log(`[macos-whisper-runtime] Runtime bytes: ${totalBytes}`)
  console.log(`[macos-whisper-runtime] whisper-cpp sha256: ${archiveHash}`)
}

main().catch((error) => {
  console.error(`[macos-whisper-runtime] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
