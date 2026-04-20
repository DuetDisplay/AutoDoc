const { readdir, stat } = require('fs/promises')
const { existsSync } = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')

const APP_ENTITLEMENTS_PATH = join(process.cwd(), 'build', 'entitlements.mac.plist')

function getSigningIdentity() {
  if (process.env.CSC_NAME) {
    return process.env.CSC_NAME
  }

  const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const line = output
    .split(/\r?\n/)
    .find((entry) => entry.includes('Developer ID Application:'))

  const match = line?.match(/"(.+)"/)
  if (!match) {
    throw new Error('Unable to determine Developer ID Application signing identity for macOS resource signing.')
  }

  return match[1]
}

async function walk(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(entryPath))
      continue
    }
    files.push(entryPath)
  }

  return files
}

function isMachOBinary(filePath) {
  try {
    const output = execFileSync('file', ['-b', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.includes('Mach-O')
  } catch {
    return false
  }
}

async function signMacResources(appBundlePath) {
  const runtimeRoot = join(appBundlePath, 'Contents', 'Resources', 'python-runtime')
  if (!existsSync(runtimeRoot)) {
    return
  }

  const identity = getSigningIdentity()
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
    execFileSync('codesign', [
      '--force',
      '--sign',
      identity,
      '--timestamp',
      '--options',
      'runtime',
      binaryPath,
    ], { stdio: 'inherit' })
  }

  execFileSync('codesign', [
    '--force',
    '--deep',
    '--sign',
    identity,
    '--timestamp',
    '--options',
    'runtime',
    '--entitlements',
    APP_ENTITLEMENTS_PATH,
    appBundlePath,
  ], { stdio: 'inherit' })

  console.log(`[afterSign] Signed ${binaries.length} bundled macOS Python binaries`)
}

module.exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const expectedAppBundlePath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const appBundlePath = existsSync(expectedAppBundlePath)
    ? expectedAppBundlePath
    : context.appOutDir

  await signMacResources(appBundlePath)
}
