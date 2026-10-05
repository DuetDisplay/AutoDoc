const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { readFile, stat, writeFile } = require('node:fs/promises')
const path = require('node:path')
const prettier = require('prettier')

const ROOT = process.cwd()
const MANIFEST_PATH = path.join(ROOT, 'resources', 'windows-transcription-manifest.json')
const MAX_RELEASE_PART_BYTES = 2_000_000_000
const UNSIGNED_RUNTIME_NAMES = [
  'canary-cuda-runtime-win-x64.zip',
  'whisper-cpp-vulkan-runtime-win-x64.zip'
]

// Immutable windows-transcription-v2 GitHub release files. Never modify v2.
const V2_RELEASE_FILES = {
  'faster-whisper-distil-large-v3-ct2.zip': {
    bytes: 1397218990,
    sha256: '81ae0a2cc4dfe70370cb33129c191365e0c090dddb4924b077ee0ffad42b5064'
  },
  'faster-whisper-runtime-cpu-win-x64.zip': {
    bytes: 122910760,
    sha256: '63cc6240161372f9f45c2b218664a5cf3f7349530a7bdd9ed129849a90ff2ca9'
  },
  'faster-whisper-runtime-cuda-win-x64.zip': {
    bytes: 1439431425,
    sha256: '785d572be18d058882fd3256b8aec4bd249ddf77f3f392659372ddf08c85bf1a'
  },
  'faster-whisper-small-en-ct2-int8.zip': {
    bytes: 445198952,
    sha256: '1347c7e02d8d70be7d5c7ed88729c29c9abc716f39322d62d6342b9a741bcaa8'
  },
  'parakeet-runtime-win-x64.zip': {
    bytes: 87511283,
    sha256: 'e9a7e85dd29f6803a7ae976406c5cd33a49acb8296e1ec104d5aecd60cbcace3'
  },
  'parakeet-tdt-0.6b-v3-fp32.zip.part1': {
    bytes: 1185405817,
    sha256: 'e0f7ef1d42db37c3d2866d13bd68d251697e50ba877a3c39375ee1df005f0bf1'
  },
  'parakeet-tdt-0.6b-v3-fp32.zip.part2': {
    bytes: 1185405816,
    sha256: 'b2e1f79ab9e2467617dae80709646621b470a3e0343f63b332a2c6addfe2a298'
  },
  'parakeet-tdt-0.6b-v3-int8.zip': {
    bytes: 480454890,
    sha256: '656335b7d7a4e1c6ecb3d78f2ac2ad342ae7865e34ec9d21905ea8c1a5e65733'
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

async function describeFile(filePath) {
  const info = await stat(filePath)
  return {
    filename: path.basename(filePath),
    bytes: info.size,
    sha256: await hashFile(filePath)
  }
}

function collectUniqueAssets(manifest) {
  const assets = new Map()
  for (const profile of manifest.profiles ?? []) {
    for (const asset of profile.assets ?? []) {
      if (!asset?.filename || assets.has(asset.filename)) continue
      assets.set(asset.filename, asset)
    }
  }
  return assets
}

function uploadFilenames(asset) {
  if (asset.parts?.length) {
    return asset.parts.map((part) => part.filename)
  }
  return [asset.filename]
}

function assertV2Match(filename, bytes, sha256) {
  const expected = V2_RELEASE_FILES[filename]
  if (!expected) return
  if (bytes !== expected.bytes || sha256 !== expected.sha256) {
    throw new Error(
      `${filename} must stay byte-identical to windows-transcription-v2 ` +
        `(expected ${expected.bytes} ${expected.sha256}, got ${bytes} ${sha256})`
    )
  }
}

async function loadProvenance(assetDir) {
  const provenancePath = path.join(assetDir, 'assets.json')
  try {
    const payload = JSON.parse(await readFile(provenancePath, 'utf8'))
    const byName = new Map()
    for (const entry of payload.assets ?? []) {
      if (entry?.filename) byName.set(entry.filename, entry)
    }
    return byName
  } catch {
    return new Map()
  }
}

function lookupProvenance(filename, provenanceByName) {
  if (provenanceByName.has(filename)) return provenanceByName.get(filename)
  const partMatch = filename.match(/^(.*\.zip)\.part\d+$/)
  if (partMatch) return provenanceByName.get(partMatch[1])
  return null
}

function provenanceSummary(entry) {
  if (!entry) return ''
  const bits = []
  if (entry.huggingface) bits.push(`HF ${entry.huggingface}`)
  if (entry.whisper_cpp_tag) {
    bits.push(
      entry.whisper_cpp_commit
        ? `whisper.cpp ${entry.whisper_cpp_tag} ${entry.whisper_cpp_commit}`
        : `whisper.cpp ${entry.whisper_cpp_tag}`
    )
  }
  if (entry.packaging_choice) {
    bits.push(entry.packaging_choice)
  } else if (!entry.huggingface && !entry.whisper_cpp_tag && entry.source_provenance) {
    const notes = [...new Set(Object.values(entry.source_provenance).map((value) => String(value)))]
    if (notes[0]) bits.push(notes[0])
  }
  if (Array.isArray(entry.licenses) && entry.licenses.length) {
    bits.push(`licenses: ${entry.licenses.join('; ')}`)
  }
  return bits.join(' · ')
}

async function signingIsPending(assetDir) {
  try {
    const text = await readFile(path.join(assetDir, 'SIGNING-REPORT.md'), 'utf8')
    const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? ''
    return /DRY RUN/i.test(firstLine)
  } catch {
    return true
  }
}

function escapeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
}

async function main() {
  const assetDir = process.argv[2]
  if (!assetDir) {
    throw new Error(
      'Usage: node scripts/write-windows-transcription-release-manifest.js <assetDir>'
    )
  }

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const uniqueAssets = collectUniqueAssets(manifest)
  const hashed = new Map()
  const mismatches = []

  for (const asset of uniqueAssets.values()) {
    const zipPath = path.join(assetDir, asset.filename)
    if (!(await exists(zipPath))) {
      throw new Error(`Missing whole zip: ${zipPath}`)
    }
    process.stdout.write(`hashing ${asset.filename}...\n`)
    const zipInfo = await describeFile(zipPath)
    assertV2Match(zipInfo.filename, zipInfo.bytes, zipInfo.sha256)

    const parts = []
    for (const part of asset.parts ?? []) {
      const partPath = path.join(assetDir, part.filename)
      if (!(await exists(partPath))) {
        throw new Error(`Missing part: ${partPath}`)
      }
      process.stdout.write(`hashing ${part.filename}...\n`)
      const partInfo = await describeFile(partPath)
      assertV2Match(partInfo.filename, partInfo.bytes, partInfo.sha256)
      parts.push(partInfo)
    }

    if (asset.sha256 !== zipInfo.sha256 || asset.bytes !== zipInfo.bytes) {
      mismatches.push(
        `${asset.filename}: manifest ${asset.bytes} ${asset.sha256} != disk ${zipInfo.bytes} ${zipInfo.sha256}`
      )
    }
    for (const partInfo of parts) {
      const previous = (asset.parts ?? []).find((part) => part.filename === partInfo.filename)
      if (previous && (previous.sha256 !== partInfo.sha256 || previous.bytes !== partInfo.bytes)) {
        mismatches.push(
          `${partInfo.filename}: manifest ${previous.bytes} ${previous.sha256} != disk ${partInfo.bytes} ${partInfo.sha256}`
        )
      }
    }

    hashed.set(asset.filename, { ...zipInfo, parts })
  }

  for (const profile of manifest.profiles ?? []) {
    for (const asset of profile.assets ?? []) {
      const artifact = hashed.get(asset.filename)
      if (!artifact) continue
      asset.sha256 = artifact.sha256
      asset.bytes = artifact.bytes
      if (artifact.parts.length) {
        if (!asset.parts?.length) {
          throw new Error(`${asset.filename} is split on disk but the manifest has no parts`)
        }
        for (const part of asset.parts) {
          const partInfo = artifact.parts.find((entry) => entry.filename === part.filename)
          if (!partInfo) {
            throw new Error(`Hashed parts are missing ${part.filename}`)
          }
          part.sha256 = partInfo.sha256
          part.bytes = partInfo.bytes
        }
      }
    }
  }

  await writeFile(
    MANIFEST_PATH,
    await prettier.format(JSON.stringify(manifest, null, 2), {
      ...(await prettier.resolveConfig(MANIFEST_PATH)),
      filepath: MANIFEST_PATH
    })
  )

  const summaryLines = ['# Windows transcription assets', '']
  for (const artifact of hashed.values()) {
    summaryLines.push(`- ${artifact.filename}`)
    summaryLines.push(`  - bytes: ${artifact.bytes}`)
    summaryLines.push(`  - sha256: ${artifact.sha256}`)
    for (const part of artifact.parts) {
      summaryLines.push(`  - part: ${part.filename}`)
      summaryLines.push(`    - bytes: ${part.bytes}`)
      summaryLines.push(`    - sha256: ${part.sha256}`)
    }
  }
  await writeFile(path.join(assetDir, 'SHA256SUMS.md'), `${summaryLines.join('\n')}\n`)

  const pendingSigning = await signingIsPending(assetDir)
  if (pendingSigning) {
    console.warn(
      'WARNING: canary-cuda-runtime-win-x64.zip and whisper-cpp-vulkan-runtime-win-x64.zip look unsigned. ' +
        'SIGNING-REPORT.md is missing or its first non-empty line contains DRY RUN. Re-run this script after signing.'
    )
  }

  const provenanceByName = await loadProvenance(assetDir)
  const uploadRows = []
  const seenUploads = new Set()
  const notUploaded = []

  for (const asset of uniqueAssets.values()) {
    const artifact = hashed.get(asset.filename)
    if (artifact.parts.length) {
      notUploaded.push(artifact.filename)
    }
    for (const filename of uploadFilenames(asset)) {
      if (seenUploads.has(filename)) continue
      seenUploads.add(filename)
      const info =
        filename === artifact.filename
          ? artifact
          : artifact.parts.find((part) => part.filename === filename)
      if (!info) {
        throw new Error(`No hash recorded for upload file ${filename}`)
      }
      if (info.bytes > MAX_RELEASE_PART_BYTES) {
        throw new Error(
          `${filename} is ${info.bytes} bytes and exceeds the ${MAX_RELEASE_PART_BYTES} GitHub upload limit; split it into .partN files`
        )
      }
      const origin = V2_RELEASE_FILES[filename] ? 'v2 (byte-identical)' : 'new'
      const pending =
        pendingSigning && UNSIGNED_RUNTIME_NAMES.includes(filename) ? 'PENDING SIGNING' : ''
      const provenance =
        origin === 'new' ? provenanceSummary(lookupProvenance(filename, provenanceByName)) : ''
      uploadRows.push({
        filename,
        bytes: info.bytes,
        sha256: info.sha256,
        origin,
        notes: [pending, provenance].filter(Boolean).join(' · ')
      })
    }
  }
  const missingV2 = Object.keys(V2_RELEASE_FILES).filter((filename) => !seenUploads.has(filename))
  if (missingV2.length) {
    throw new Error(
      `windows-transcription-v3 upload set is missing v2 files: ${missingV2.join(', ')}`
    )
  }

  uploadRows.push({
    filename: 'SHA256SUMS.md',
    bytes: '',
    sha256: '',
    origin: 'new',
    notes: 'generated checksum list; no hash needed for itself'
  })

  const uploadLines = [
    '# windows-transcription-v3 upload manifest',
    '',
    '| filename | bytes | sha256 | origin | notes |',
    '| --- | --- | --- | --- | --- |',
    ...uploadRows.map(
      (row) =>
        `| ${escapeCell(row.filename)} | ${escapeCell(row.bytes)} | ${escapeCell(row.sha256)} | ${escapeCell(row.origin)} | ${escapeCell(row.notes)} |`
    ),
    '',
    '## Do not upload',
    '',
    'Whole zips larger than 2 GB stay local. GitHub Releases only accept the `.partN` files; the app concatenates them.',
    '',
    ...notUploaded.map((filename) => `- ${filename}`),
    ''
  ]
  await writeFile(path.join(assetDir, 'UPLOAD-MANIFEST.md'), uploadLines.join('\n'))

  if (mismatches.length) {
    console.log('Manifest hashes that did not match disk before update:')
    for (const line of mismatches) console.log(`  ${line}`)
  } else {
    console.log('All manifest hashes already matched the files on disk.')
  }
  console.log(`Wrote ${MANIFEST_PATH}`)
  console.log(`Wrote ${path.join(assetDir, 'SHA256SUMS.md')}`)
  console.log(`Wrote ${path.join(assetDir, 'UPLOAD-MANIFEST.md')}`)
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
  console.error('[write-windows-transcription-release-manifest] Failed')
  console.error(error)
  process.exitCode = 1
})
