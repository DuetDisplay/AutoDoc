const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

if (process.platform !== 'win32') {
  process.exit(0)
}

const repoRoot = path.resolve(__dirname, '..')
const sourcePath = path.join(repoRoot, 'native', 'win-meeting-detector', 'win-meeting-detector.cpp')
const outputDir = path.join(repoRoot, 'native', 'win-meeting-detector', 'bin')
const outputPath = path.join(outputDir, 'win-meeting-detector.exe')

const vsDevCmd = findVsDevCmd()
if (!vsDevCmd) {
  console.error('Could not find Visual Studio developer tools (VsDevCmd.bat).')
  process.exit(1)
}

if (isUpToDate(outputPath, [sourcePath, __filename])) {
  process.exit(0)
}

fs.mkdirSync(outputDir, { recursive: true })

const scriptPath = path.join(outputDir, 'build-win-meeting-detector.cmd')
const command = [
  '@echo off',
  `call "${vsDevCmd}" -no_logo -arch=x64`,
  'if errorlevel 1 exit /b %errorlevel%',
  'cl.exe /nologo /std:c++17 /EHsc /utf-8 /O2 /DUNICODE /D_UNICODE /DNOMINMAX /DWIN32_LEAN_AND_MEAN ' +
    `/Fo"${path.join(outputDir, 'win-meeting-detector.obj')}" ` +
    `/Fe"${outputPath}" ` +
    `"${sourcePath}" ole32.lib uuid.lib`,
].join('\r\n')

fs.writeFileSync(scriptPath, command)

const result = spawnSync(scriptPath, [], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
  shell: true,
})

fs.rmSync(scriptPath, { force: true })

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

function findVsDevCmd() {
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
  ].filter(Boolean)

  const editions = ['Enterprise', 'Professional', 'Community', 'BuildTools']

  for (const root of roots) {
    for (const edition of editions) {
      const candidate = path.join(root, 'Microsoft Visual Studio', '2022', edition, 'Common7', 'Tools', 'VsDevCmd.bat')
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }

  return null
}

function isUpToDate(outputFile, inputs) {
  if (!fs.existsSync(outputFile)) return false

  const outputMtime = fs.statSync(outputFile).mtimeMs
  return inputs.every((input) => fs.existsSync(input) && fs.statSync(input).mtimeMs <= outputMtime)
}
