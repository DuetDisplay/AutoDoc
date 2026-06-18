const { readdir, rm, stat } = require('fs/promises')
const { existsSync } = require('fs')
const { isAbsolute, join } = require('path')
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

// The bundled MLX/Python runtime allocates executable (JIT) memory at import
// time. Because `mac.signIgnore` excludes Contents/Resources, electron-builder's
// signer never applies the inherited entitlements to these binaries, so we must
// sign them here with the same Hardened Runtime entitlements the main app uses
// (allow-jit / allow-unsigned-executable-memory). Without them macOS SIGKILLs
// the runtime with "Code Signature Invalid" the moment transcription starts.
function resolveResourceEntitlementsPath(context) {
  const configured =
    context?.packager?.platformSpecificBuildOptions?.entitlements ??
    context?.packager?.config?.mac?.entitlements ??
    context?.packager?.platformSpecificBuildOptions?.entitlementsInherit ??
    context?.packager?.config?.mac?.entitlementsInherit

  const candidates = []
  if (configured) {
    candidates.push(isAbsolute(configured) ? configured : join(process.cwd(), configured))
  }
  candidates.push(join(__dirname, '..', 'build', 'entitlements.mac.plist'))

  return candidates.find((candidate) => existsSync(candidate)) ?? null
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

  const entitlementsPath = resolveResourceEntitlementsPath(context)
  if (!entitlementsPath) {
    console.warn(
      `[afterPack] WARNING: no entitlements file found for ${label}; the bundled runtime may be SIGKILLed at runtime (missing allow-jit).`
    )
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
    const codesignArgs = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime']
    if (entitlementsPath) {
      codesignArgs.push('--entitlements', entitlementsPath)
    }
    codesignArgs.push(binaryPath)
    execFileSync('codesign', codesignArgs, { stdio: 'inherit' })
  }

  if (binaries.length > 0 && entitlementsPath) {
    console.log(
      `[afterPack] Applied Hardened Runtime entitlements (${entitlementsPath}) to ${binaries.length} ${label}`
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
