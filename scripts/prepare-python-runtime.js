#!/usr/bin/env node

const { mkdir, access } = require('fs/promises')
const { createWriteStream } = require('fs')
const { join } = require('path')

const PYTHON_RELEASE_TAG = '20260414'
const PYTHON_VERSION = '3.11.15'
const OUTPUT_DIR = join(process.cwd(), 'vendor', 'python-runtime')

const TARGETS = {
  'darwin-arm64': {
    platform: 'darwin',
    triplet: 'aarch64-apple-darwin',
  },
  'darwin-x64': {
    platform: 'darwin',
    triplet: 'x86_64-apple-darwin',
  },
  'win32-arm64': {
    platform: 'win32',
    triplet: 'aarch64-pc-windows-msvc',
  },
  'win32-x64': {
    platform: 'win32',
    triplet: 'x86_64-pc-windows-msvc',
  },
}

function getArchiveFilename(target) {
  return `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-${target.triplet}-install_only.tar.gz`
}

function getArchiveUrl(target) {
  const encodedVersion = `${PYTHON_VERSION}%2B${PYTHON_RELEASE_TAG}`
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/cpython-${encodedVersion}-${target.triplet}-install_only.tar.gz`
}

function getDefaultTargetKeys() {
  if (process.platform === 'darwin') {
    return ['darwin-arm64', 'darwin-x64']
  }
  if (process.platform === 'win32') {
    return ['win32-arm64', 'win32-x64']
  }
  return []
}

function getRequestedTargetKeys() {
  const raw = process.env.AUTODOC_PYTHON_BUNDLE_TARGETS?.trim()
  if (!raw) {
    return getDefaultTargetKeys()
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function downloadFile(url, destPath, label) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`)
  }

  const totalBytes = Number(response.headers.get('content-length') ?? 0)
  let downloadedBytes = 0
  const fileStream = createWriteStream(destPath)
  const reader = response.body?.getReader()

  if (!reader) {
    throw new Error(`No response body for ${label}`)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      fileStream.write(value)
      downloadedBytes += value.length
      if (totalBytes > 0) {
        const percent = Math.round((downloadedBytes / totalBytes) * 100)
        process.stdout.write(`\r[python-runtime] ${label}: ${percent}%`)
      }
    }
  } finally {
    fileStream.end()
    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve)
      fileStream.on('error', reject)
    })
    process.stdout.write('\n')
  }
}

async function ensureTargetArchive(targetKey) {
  const target = TARGETS[targetKey]
  if (!target) {
    throw new Error(`Unknown Python runtime target: ${targetKey}`)
  }

  const archiveFilename = getArchiveFilename(target)
  const archivePath = join(OUTPUT_DIR, archiveFilename)
  if (await fileExists(archivePath)) {
    console.log(`[python-runtime] Reusing ${archiveFilename}`)
    return
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  console.log(`[python-runtime] Downloading ${archiveFilename}`)
  await downloadFile(getArchiveUrl(target), archivePath, archiveFilename)
}

async function main() {
  const targetKeys = getRequestedTargetKeys()
  if (targetKeys.length === 0) {
    console.log('[python-runtime] No managed Python targets for this platform; skipping')
    return
  }

  for (const targetKey of targetKeys) {
    await ensureTargetArchive(targetKey)
  }
}

main().catch((err) => {
  console.error('[python-runtime] Failed to prepare managed Python runtime archives')
  console.error(err)
  process.exitCode = 1
})
