import { safeStorage } from 'electron'
import Store from 'electron-store'
import crypto from 'crypto'

const store = new Store({ name: 'autodoc-tokens' })

const LEGACY_TOKEN_KEY = 'gcal_tokens'

function tokenKey(accountId: string): string {
  return `cal_tokens_${accountId}`
}

function encryptedFlagKey(key: string): string {
  return `${key}_encrypted`
}

function saveRaw(key: string, data: object): void {
  const json = JSON.stringify(data)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(json)
    store.set(key, encrypted.toString('latin1'))
    store.set(encryptedFlagKey(key), true)
  } else {
    store.set(key, json)
    store.set(encryptedFlagKey(key), false)
  }
}

function loadRaw(key: string): object | null {
  const raw = store.get(key) as string | undefined
  if (!raw) return null
  try {
    const isEncrypted = store.get(encryptedFlagKey(key)) as boolean
    if (isEncrypted && safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(Buffer.from(raw, 'latin1'))
      return JSON.parse(decrypted)
    }
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function clearRaw(key: string): void {
  store.delete(key)
  store.delete(encryptedFlagKey(key))
}

// --- Account-scoped API ---

export function saveTokensForAccount(accountId: string, tokens: object): void {
  saveRaw(tokenKey(accountId), tokens)
}

export function loadTokensForAccount(accountId: string): object | null {
  return loadRaw(tokenKey(accountId))
}

export function clearTokensForAccount(accountId: string): void {
  clearRaw(tokenKey(accountId))
}

export function hasTokensForAccount(accountId: string): boolean {
  return store.has(tokenKey(accountId))
}

// --- Legacy migration ---

export function migrateLegacyTokens(): string | null {
  const legacyTokens = loadRaw(LEGACY_TOKEN_KEY)
  if (!legacyTokens) return null

  const accountId = crypto.randomUUID()
  saveRaw(tokenKey(accountId), legacyTokens)
  clearRaw(LEGACY_TOKEN_KEY)

  return accountId
}

// --- Backward-compatible API (used during refactor transition) ---

export function saveTokens(tokens: object): void {
  saveRaw(LEGACY_TOKEN_KEY, tokens)
}

export function loadTokens(): object | null {
  return loadRaw(LEGACY_TOKEN_KEY)
}

export function clearTokens(): void {
  clearRaw(LEGACY_TOKEN_KEY)
}
