const { readdir } = require('fs/promises')
const { existsSync } = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')

const PRIVACY_STRINGS = {
  NSMicrophoneUsageDescription: 'Application requires access to the microphone.',
  NSAudioCaptureUsageDescription: 'Application requests access to capture system audio during screen recording.',
}

function setPlistString(plistPath, key, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath], {
      stdio: 'pipe',
    })
    return
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plistPath], {
      stdio: 'pipe',
    })
  }
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

  const expectedAppBundlePath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const appBundlePath = existsSync(expectedAppBundlePath)
    ? expectedAppBundlePath
    : context.appOutDir

  const patchedPlists = await patchNestedAppPrivacyStrings(appBundlePath)
  if (patchedPlists.length > 0) {
    console.log(`[afterPack] Patched privacy usage strings in ${patchedPlists.length} helper app plists`)
  }
}
