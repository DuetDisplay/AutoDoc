import { execFileSync } from 'child_process'
import { timingSafeEqual } from 'crypto'
import { resolveWindowsMeetingDetectorPath } from './windows-meeting-detector'

const MAX_PROTECTED_KEY_BYTES = 64 * 1024

function runKeyProtection(command: '--protect-key' | '--unprotect-key', input: Buffer): Buffer {
  const helperPath = resolveWindowsMeetingDetectorPath()
  if (!helperPath) throw new Error('Windows recording key protection helper is unavailable')
  try {
    return execFileSync(helperPath, [command], {
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: MAX_PROTECTED_KEY_BYTES
    })
  } catch {
    // Child-process errors can carry raw stdout/input. Never propagate that object.
    throw new Error('Windows recording key protection failed')
  }
}

export function protectWindowsRecordingKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('Invalid Windows recording key length')
  const protectedKey = runKeyProtection('--protect-key', key)
  if (protectedKey.length <= 32 || protectedKey.length > MAX_PROTECTED_KEY_BYTES) {
    throw new Error('Invalid Windows protected recording key')
  }
  const recovered = unprotectWindowsRecordingKey(protectedKey)
  try {
    if (!timingSafeEqual(recovered, key)) {
      throw new Error('Windows protected recording key validation failed')
    }
  } finally {
    recovered.fill(0)
  }
  return protectedKey
}

export function unprotectWindowsRecordingKey(protectedKey: Buffer): Buffer {
  if (protectedKey.length <= 32 || protectedKey.length > MAX_PROTECTED_KEY_BYTES) {
    throw new Error('Invalid Windows protected recording key')
  }
  const key = runKeyProtection('--unprotect-key', protectedKey)
  if (key.length !== 32) throw new Error('Invalid Windows recording key length')
  return key
}
