const { readdir, rm, stat } = require('fs/promises')
const { existsSync } = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')

const PRIVACY_STRINGS = {
  NSMicrophoneUsageDescription: 'Application requires access to the microphone.',
  NSAudioCaptureUsageDescription:
    'Application requests access to capture system audio during screen recording.'
}

function setPlistString(plistPath, key, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath], {
      stdio: 'pipe'
    })
    return
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plistPath], {
      stdio: 'pipe'
    })
  }
}

function getConfiguredSigningIdentity(context) {
  const identity =
    context?.packager?.platformSpecificBuildOptions?.identity ??
    context?.packager?.config?.mac?.identity

  if (!identity || identity === '-') {
    return null
  }

  return identity
}

function findSigningIdentity(predicate) {
  try {
    const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const line = output.split(/\r?\n/).find(predicate)

    const match = line?.match(/"(.+)"/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function tryGetSigningIdentity(context) {
  if (process.env.CSC_NAME) {
    return process.env.CSC_NAME
  }

  return (
    getConfiguredSigningIdentity(context) ??
    findSigningIdentity((entry) => entry.includes('Developer ID Application:')) ??
    findSigningIdentity((entry) => entry.includes('Apple Development:'))
  )
}

async function walk(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)))
      continue
    }
    files.push(entryPath)
  }

  return files
}

async function removeAppleDoubleFiles(dirPath) {
  if (!existsSync(dirPath)) {
    return 0
  }

  let removed = 0
  const entries = await readdir(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name)
    if (entry.name.startsWith('._')) {
      await rm(entryPath, { recursive: entry.isDirectory(), force: true })
      removed += 1
      continue
    }
    if (entry.isDirectory()) {
      removed += await removeAppleDoubleFiles(entryPath)
    }
  }

  return removed
}

function isMachOBinary(filePath) {
  try {
    const output = execFileSync('file', ['-b', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output.includes('Mach-O')
  } catch {
    return false
  }
}

async function signBundledResourceMachOBinaries(appBundlePath, context) {
  const resourcesRoot = join(appBundlePath, 'Contents', 'Resources')
  return await signMachOBinariesUnder(resourcesRoot, 'bundled macOS resource Mach-O binaries', context)
}

async function signMachOBinariesUnder(runtimeRoot, label, context) {
  if (!existsSync(runtimeRoot)) {
    return 0
  }

  const identity = tryGetSigningIdentity(context)
  if (!identity) {
    console.log(
      `[afterPack] Skipped signing ${label} because no macOS code signing identity is available`
    )
    return 0
  }

  const files = await walk(runtimeRoot)
  const binaries = []

  for (const filePath of files) {
    const fileInfo = await stat(filePath)
    if (!fileInfo.isFile()) {
      continue
    }
    if (isMachOBinary(filePath)) {
      binaries.push(filePath)
    }
  }

  binaries.sort((left, right) => right.split('/').length - left.split('/').length)

  for (const binaryPath of binaries) {
    execFileSync(
      'codesign',
      ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', binaryPath],
      { stdio: 'inherit' }
    )
  }

  return binaries.length
}

async function patchNestedAppPrivacyStrings(appBundlePath) {
  const frameworksDir = join(appBundlePath, 'Contents', 'Frameworks')
  if (!existsSync(frameworksDir)) {
    return []
  }

  const entries = await readdir(frameworksDir, { withFileTypes: true })
  const patchedPlists = []

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) {
      continue
    }

    const plistPath = join(frameworksDir, entry.name, 'Contents', 'Info.plist')
    if (!existsSync(plistPath)) {
      continue
    }

    for (const [key, value] of Object.entries(PRIVACY_STRINGS)) {
      setPlistString(plistPath, key, value)
    }
    patchedPlists.push(plistPath)
  }

  return patchedPlists
}

module.exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const expectedAppBundlePath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  const appBundlePath = existsSync(expectedAppBundlePath)
    ? expectedAppBundlePath
    : context.appOutDir

  const removedWhisperAppleDoubleFiles = await removeAppleDoubleFiles(
    join(appBundlePath, 'Contents', 'Resources', 'macos-whisper-runtime')
  )
  const patchedPlists = await patchNestedAppPrivacyStrings(appBundlePath)
  const signedResourceBinaries = await signBundledResourceMachOBinaries(appBundlePath, context)

  if (patchedPlists.length > 0) {
    console.log(
      `[afterPack] Patched privacy usage strings in ${patchedPlists.length} helper app plists`
    )
  }
  if (removedWhisperAppleDoubleFiles > 0) {
    console.log(
      `[afterPack] Removed ${removedWhisperAppleDoubleFiles} AppleDouble files from bundled macOS Whisper runtime`
    )
  }
  if (signedResourceBinaries > 0) {
    console.log(
      `[afterPack] Signed ${signedResourceBinaries} bundled macOS resource Mach-O binaries before final app signing`
    )
  }
}
