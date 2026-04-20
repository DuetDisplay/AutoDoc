'use strict'

const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

function isTruthy(value) {
  return value === '1' || value === 'true'
}

function resolveSmctlPath() {
  const configuredPath = process.env.SMCTL_PATH
  if (configuredPath && existsSync(configuredPath)) {
    return configuredPath
  }

  try {
    const resolved = execFileSync('where.exe', ['smctl'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && existsSync(line))

    if (resolved) {
      return resolved
    }
  } catch {}

  const candidatePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Temp', 'smtools-windows-x64', 'smctl.exe'),
    path.join(process.env.ProgramFiles || '', 'DigiCert', 'DigiCert One Signing Manager Tools', 'smctl.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'DigiCert', 'DigiCert One Signing Manager Tools', 'smctl.exe'),
  ]

  return candidatePaths.find((candidate) => candidate && existsSync(candidate)) || null
}

exports.default = async function sign(configuration) {
  const targetPath = configuration.path

  if (!targetPath || !existsSync(targetPath)) {
    return
  }

  const keypairAlias = process.env.SM_KEYPAIR_ALIAS
  const requireSigning = isTruthy(process.env.REQUIRE_WINDOWS_SIGNING)
  const smctlPath = resolveSmctlPath()

  if (!keypairAlias) {
    if (requireSigning) {
      throw new Error('Windows signing is required, but SM_KEYPAIR_ALIAS is not set.')
    }
    return
  }

  if (!smctlPath || !existsSync(smctlPath)) {
    if (requireSigning) {
      throw new Error('Windows signing is required, but smctl was not found on PATH or in the standard DigiCert install locations.')
    }
    return
  }

  console.log(`[windows-sign] Signing ${targetPath} with keypair alias ${keypairAlias}`)

  execFileSync(
    smctlPath,
    ['sign', '--verbose', '--keypair-alias', keypairAlias, '--input', String(targetPath)],
    { stdio: 'inherit' }
  )
}
