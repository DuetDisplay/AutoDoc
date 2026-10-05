'use strict'

const { spawnSync } = require('node:child_process')
const { mkdir, readFile, rename, rm, stat, writeFile } = require('node:fs/promises')
const path = require('node:path')

const signBinary = require('./windows-sign').default

const SIGN_ZIPS = ['whisper-cpp-vulkan-runtime-win-x64.zip', 'canary-cuda-runtime-win-x64.zip']
const MAX_ZIP_BYTES = 2_000_000_000
const VENDOR_UNSIGNED_PREFIXES = ['Lib/site-packages/nvidia/']

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Windows transcription asset signing must run on Windows.')
  }

  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const positional = args.filter((arg) => arg !== '--dry-run')
  if (positional.length !== 1) {
    throw new Error(
      'Usage: node scripts/sign-windows-transcription-assets.js <assetDir> [--dry-run]'
    )
  }

  const assetDir = path.resolve(positional[0])
  for (const zipName of SIGN_ZIPS) {
    const zipPath = path.join(assetDir, zipName)
    if (!(await exists(zipPath))) {
      throw new Error(`Missing required zip: ${zipPath}`)
    }
  }

  const stagingRoot = path.join(assetDir, '_sign-staging')
  const reports = []

  try {
    await rm(stagingRoot, { recursive: true, force: true })
    await mkdir(stagingRoot, { recursive: true })

    for (const zipName of SIGN_ZIPS) {
      reports.push(await processZip(assetDir, stagingRoot, zipName, dryRun))
    }

    const reportPath = path.join(assetDir, 'SIGNING-REPORT.md')
    await writeFile(reportPath, renderReport(reports, dryRun))
    printSummary(reports, reportPath, dryRun)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function processZip(assetDir, stagingRoot, zipName, dryRun) {
  const zipPath = path.join(assetDir, zipName)
  const extractDir = path.join(stagingRoot, path.basename(zipName, '.zip'))

  await rm(extractDir, { recursive: true, force: true })
  await mkdir(extractDir, { recursive: true })

  const originalEntries = listZipEntries(zipPath)

  console.log(`[sign-windows-transcription-assets] Extracting ${zipName}`)
  run('tar', ['-xf', zipPath, '-C', extractDir])

  const classified = await classifyPeFiles(extractDir, zipName)
  const vendorUnsigned = classified.filter(
    (row) => row.Status === 'NotSigned' && isVendorUnsignedPath(row.path)
  )
  const toSign = classified.filter(
    (row) => row.Status === 'NotSigned' && !isVendorUnsignedPath(row.path)
  )
  const vendorSigned = classified.filter((row) => row.Status === 'Valid')
  let ourSignerCn = null

  if (!dryRun) {
    process.env.REQUIRE_WINDOWS_SIGNING = '1'
    for (const row of toSign) {
      await signBinary({ path: path.join(extractDir, row.path) })
    }

    const after = await classifyPeFiles(extractDir, zipName)
    const vendorCns = new Set(vendorSigned.map((row) => row.signer))
    const signedPaths = new Set(toSign.map((row) => row.path))
    const vendorUnsignedPaths = new Set(vendorUnsigned.map((row) => row.path))
    const stillUnsigned = after.filter(
      (row) => vendorUnsignedPaths.has(row.path) && row.Status !== 'NotSigned'
    )
    if (stillUnsigned.length > 0) {
      throw new Error(
        `NVIDIA redistributables were modified in ${zipName}:\n` +
          stillUnsigned.map((row) => `  ${row.path}: ${row.Status}`).join('\n')
      )
    }
    const stillInvalid = after.filter(
      (row) => !vendorUnsignedPaths.has(row.path) && row.Status !== 'Valid'
    )
    if (stillInvalid.length > 0) {
      throw new Error(
        `PE files were not Valid after signing ${zipName}:\n` +
          stillInvalid.map((row) => `  ${row.path}: ${row.Status}`).join('\n')
      )
    }
    const unexpectedSigners = after.filter(
      (row) => row.Status === 'Valid' && !vendorCns.has(row.signer) && !signedPaths.has(row.path)
    )
    if (unexpectedSigners.length > 0) {
      throw new Error(
        `Unexpected signer after signing ${zipName}:\n` +
          unexpectedSigners.map((row) => `  ${row.path}: ${row.signer}`).join('\n')
      )
    }
    if (signedPaths.size > 0) {
      const ourCns = [
        ...new Set(after.filter((row) => signedPaths.has(row.path)).map((row) => row.signer))
      ]
      if (ourCns.length !== 1 || !ourCns[0]) {
        throw new Error(
          `Signed files in ${zipName} do not share one signer CN: ${ourCns.join(', ') || '(none)'}`
        )
      }
      ourSignerCn = ourCns[0]
    }

    const tempZip = path.join(stagingRoot, `${zipName}.signed`)
    await zipDirectory(extractDir, tempZip)
    const nextEntries = listZipEntries(tempZip)
    if (!sameEntries(originalEntries, nextEntries)) {
      throw new Error(entryMismatchMessage(zipName, originalEntries, nextEntries))
    }

    const info = await stat(tempZip)
    if (info.size > MAX_ZIP_BYTES) {
      throw new Error(
        `${zipName} is ${info.size} bytes after signing, which exceeds ${MAX_ZIP_BYTES}.`
      )
    }

    await rm(zipPath, { force: true })
    await rename(tempZip, zipPath)
  }

  return { zipName, toSign, vendorSigned, vendorUnsigned, ourSignerCn }
}

async function classifyPeFiles(extractDir, zipName) {
  const jsonPath = `${extractDir}-signatures.json`
  const command = [
    `$root = [System.IO.Path]::GetFullPath(${powershellLiteral(extractDir)})`,
    `$jsonPath = [System.IO.Path]::GetFullPath(${powershellLiteral(jsonPath)})`,
    "$peFiles = @(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll', '.pyd' })",
    '$results = @()',
    'foreach ($file in $peFiles) {',
    '  $sig = Get-AuthenticodeSignature -LiteralPath $file.FullName',
    '  $cn = $null',
    '  if ($null -ne $sig.SignerCertificate) {',
    '    $cn = $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)',
    '  }',
    '  $relative = $file.FullName.Substring($root.Length).TrimStart("\\", "/").Replace("\\", "/")',
    '  $results += [pscustomobject]@{ path = $relative; Status = [string]$sig.Status; signer = $cn }',
    '}',
    "if ($results.Count -eq 0) { $json = '[]' } else { $json = ConvertTo-Json -Compress -Depth 4 -InputObject @($results) }",
    '[System.IO.File]::WriteAllText($jsonPath, $json)'
  ].join('\n')

  run('powershell', ['-NoProfile', '-Command', command])

  const parsed = JSON.parse(await readFile(jsonPath, 'utf8'))
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  const unexpected = rows.filter((row) => row.Status !== 'NotSigned' && row.Status !== 'Valid')
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected Authenticode status in ${zipName}:\n` +
        unexpected.map((row) => `  ${row.path}: ${row.Status}`).join('\n')
    )
  }

  const missingSigner = rows.filter((row) => row.Status === 'Valid' && !row.signer)
  if (missingSigner.length > 0) {
    throw new Error(
      `Valid signature without signer CN in ${zipName}:\n` +
        missingSigner.map((row) => `  ${row.path}`).join('\n')
    )
  }

  return rows.sort((a, b) => comparePaths(a.path, b.path))
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

function listZipEntries(zipPath) {
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip = [System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath(${powershellLiteral(zipPath)}))`,
    'try {',
    '  $zip.Entries | ForEach-Object { $_.FullName.Replace("\\", "/") }',
    '} finally {',
    '  $zip.Dispose()',
    '}'
  ].join('\n')
  const output = runCapture('powershell', ['-NoProfile', '-Command', command])
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort(comparePaths)
}

function renderReport(reports, dryRun) {
  const lines = [
    dryRun
      ? '# Windows transcription asset signing (DRY RUN)'
      : '# Windows transcription asset signing',
    ''
  ]

  for (const report of reports) {
    const signHeading = dryRun ? 'Would sign' : 'Signed'
    lines.push(`## ${report.zipName}`, '')
    if (!dryRun && report.ourSignerCn) {
      lines.push(`Signer CN: ${report.ourSignerCn}`, '')
    }
    lines.push(`### ${signHeading} (${report.toSign.length})`, '')
    if (report.toSign.length === 0) {
      lines.push('_None._', '')
    } else {
      for (const row of report.toSign) {
        lines.push(`- ${row.path}`)
      }
      lines.push('')
    }

    lines.push('### Vendor-signed', '')
    const grouped = groupBySigner(report.vendorSigned)
    if (grouped.length === 0) {
      lines.push('_None._', '')
    } else {
      for (const group of grouped) {
        lines.push(`#### ${group.signer} (${group.paths.length})`, '')
        for (const filePath of group.paths) {
          lines.push(`- ${filePath}`)
        }
        lines.push('')
      }
    }

    lines.push('### NVIDIA redistributables left as shipped (unsigned by vendor)', '')
    if (report.vendorUnsigned.length === 0) {
      lines.push('_None._', '')
    } else {
      for (const row of report.vendorUnsigned) {
        lines.push(`- ${row.path}`)
      }
      lines.push('')
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function printSummary(reports, reportPath, dryRun) {
  const verb = dryRun ? 'would sign' : 'signed'
  for (const report of reports) {
    const parts = [
      `${verb} ${report.toSign.length}`,
      `vendor-signed ${report.vendorSigned.length}`,
      `NVIDIA redistributables left as shipped ${report.vendorUnsigned.length}`
    ]
    if (!dryRun && report.ourSignerCn) {
      parts[0] += ` as ${report.ourSignerCn}`
    }
    console.log(`[sign-windows-transcription-assets] ${report.zipName}: ${parts.join(', ')}`)
  }
  console.log(`[sign-windows-transcription-assets] Wrote ${reportPath}`)
}

function isVendorUnsignedPath(relativePath) {
  return VENDOR_UNSIGNED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
}

function groupBySigner(vendorSigned) {
  const grouped = new Map()
  for (const row of vendorSigned) {
    const signer = row.signer
    if (!grouped.has(signer)) {
      grouped.set(signer, [])
    }
    grouped.get(signer).push(row.path)
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => comparePaths(a, b))
    .map(([signer, paths]) => ({ signer, paths: paths.slice().sort(comparePaths) }))
}

function sameEntries(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function entryMismatchMessage(zipName, originalEntries, nextEntries) {
  const originalSet = new Set(originalEntries)
  const nextSet = new Set(nextEntries)
  const missing = originalEntries.filter((entry) => !nextSet.has(entry)).slice(0, 10)
  const extra = nextEntries.filter((entry) => !originalSet.has(entry)).slice(0, 10)
  return [
    `Re-zipped ${zipName} entry list does not match the original zip.`,
    `original=${originalEntries.length} new=${nextEntries.length}`,
    missing.length ? `missing: ${missing.join(', ')}` : '',
    extra.length ? `extra: ${extra.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function comparePaths(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function run(command, args) {
  console.log(`[sign-windows-transcription-assets] ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit'
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`)
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
    throw new Error(
      details
        ? `${command} exited with code ${result.status}: ${details}`
        : `${command} exited with code ${result.status}`
    )
  }
  return result.stdout
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
  console.error('[sign-windows-transcription-assets] Failed')
  console.error(error)
  process.exitCode = 1
})
