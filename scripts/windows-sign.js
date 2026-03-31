'use strict'

const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')

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

  if (!keypairAlias) {
    if (requireSigning) {
      throw new Error('Windows signing is required, but SM_KEYPAIR_ALIAS is not set.')
    }
    return
  }

  execFileSync(
    'smctl',
    ['sign', '--keypair-alias', keypairAlias, '--input', String(targetPath)],
    { stdio: 'inherit' }
  )
}
