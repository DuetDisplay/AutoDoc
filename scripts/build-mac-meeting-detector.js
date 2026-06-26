const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

if (process.platform !== 'darwin') {
  process.exit(0)
}

const repoRoot = path.resolve(__dirname, '..')
const sourcePath = path.join(repoRoot, 'native', 'mac-meeting-detector', 'mac-meeting-detector.mm')
const outputDir = path.join(repoRoot, 'native', 'mac-meeting-detector', 'bin')
const outputPath = path.join(outputDir, 'mac-meeting-detector')

if (isUpToDate(outputPath, [sourcePath, __filename])) {
  process.exit(0)
}

const clangPath = readXcrunOutput(['--find', 'clang++'])
const sdkPath = readXcrunOutput(['--sdk', 'macosx', '--show-sdk-path'])
if (!clangPath || !sdkPath) {
  console.error('Could not resolve Xcode command line tools for mac meeting detector.')
  process.exit(1)
}

fs.mkdirSync(outputDir, { recursive: true })

const result = spawnSync(
  clangPath,
  [
    '-std=c++17',
    '-O2',
    '-fobjc-arc',
    '-isysroot',
    sdkPath,
    sourcePath,
    '-o',
    outputPath,
    '-framework',
    'AppKit',
    '-framework',
    'CoreAudio',
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  },
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

function readXcrunOutput(args) {
  const result = spawnSync('xcrun', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

function isUpToDate(outputFile, inputs) {
  if (!fs.existsSync(outputFile)) return false

  const outputMtime = fs.statSync(outputFile).mtimeMs
  return inputs.every((input) => fs.existsSync(input) && fs.statSync(input).mtimeMs <= outputMtime)
}
