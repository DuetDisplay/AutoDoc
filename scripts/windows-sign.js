'use strict'

const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

function isTruthy(value) {
  return value === '1' || value === 'true'
}

exports.default = async function sign(configuration) {
  const targetPath = configuration.path

  if (!targetPath || !existsSync(targetPath)) {
    return
  }

  const keypairAlias = process.env.SM_KEYPAIR_ALIAS
  const requireSigning = isTruthy(process.env.REQUIRE_WINDOWS_SIGNING)
  const smctlPath =
    process.env.SMCTL_PATH ||
    path.join(process.env.LOCALAPPDATA || '', 'Temp', 'smtools-windows-x64', 'smctl.exe')

  if (!keypairAlias) {
    if (requireSigning) {
      throw new Error('Windows signing is required, but SM_KEYPAIR_ALIAS is not set.')
    }
    return
  }

  if (!existsSync(smctlPath)) {
    if (requireSigning) {
      throw new Error(`Windows signing is required, but smctl was not found at ${smctlPath}.`)
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
