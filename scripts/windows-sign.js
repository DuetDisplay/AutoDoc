'use strict'

const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

const RETRYABLE_ERROR_PATTERNS = [
  '0x8009002d',
  'SignerSign() failed',
  'unexpected internal error',
]

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableSigningError(error) {
  const details = [
    error && typeof error.message === 'string' ? error.message : '',
    error && typeof error.stdout === 'string' ? error.stdout : '',
    error && typeof error.stderr === 'string' ? error.stderr : '',
  ]
    .join('\n')
    .toLowerCase()

  return RETRYABLE_ERROR_PATTERNS.some((pattern) => details.includes(pattern.toLowerCase()))
}

function resyncCertificate(smctlPath, keypairAlias) {
  execFileSync(
    smctlPath,
    ['windows', 'certsync', '--keypair-alias', keypairAlias, '--store', 'system'],
    { stdio: 'inherit' },
  )
}

function attemptSigning(smctlPath, keypairAlias, targetPath) {
  execFileSync(
    smctlPath,
    ['sign', '--verbose', '--keypair-alias', keypairAlias, '--input', String(targetPath)],
    { stdio: 'inherit' },
  )
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
  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      attemptSigning(smctlPath, keypairAlias, targetPath)
      return
    } catch (error) {
      const canRetry = attempt < maxAttempts && isRetryableSigningError(error)
      if (!canRetry) {
        throw error
      }

      const waitMs = attempt * 2000
      console.warn(
        `[windows-sign] Retryable DigiCert signing failure for ${targetPath} ` +
          `(attempt ${attempt}/${maxAttempts}, waiting ${waitMs}ms before retry)`,
      )

      try {
        resyncCertificate(smctlPath, keypairAlias)
      } catch (syncError) {
        console.warn('[windows-sign] Certificate resync failed before retry:', syncError)
      }

      await sleep(waitMs)
    }
  }
}
