const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function packagedExecutablePath() {
  if (process.platform === 'darwin') {
    const directory = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
    return join(process.cwd(), 'dist-qa', directory, 'AutoDoc QA.app')
  }

  if (process.platform === 'win32') {
    const directory = process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked'
    return join(process.cwd(), 'dist-qa', directory, 'autodoc-qa.exe')
  }

  throw new Error('The packaged QA feedback test currently supports macOS and Windows.')
}

run(npmCommand, ['run', 'test:qa:run'])
run(npmCommand, ['run', 'build:qa'])
run(npxCommand, [
  'electron-builder',
  '--dir',
  '--publish',
  'never',
  '--config',
  'electron-builder.qa.yml'
])

const packagedApp = packagedExecutablePath()
if (!existsSync(packagedApp)) {
  throw new Error(`Packaged QA app was not found at ${packagedApp}`)
}

run(npxCommand, ['playwright', 'test', 'e2e/feedback-prompt-qa-simulator.spec.ts'], {
  ...process.env,
  AUTODOC_QA_PACKAGED_APP: packagedApp,
  AUTODOC_QA_DEFAULT_PROFILE_CHECK: '1'
})
