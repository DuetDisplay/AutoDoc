import { safeStorage } from 'electron'
import Store from 'electron-store'

const store = new Store({ name: 'autodoc-tokens' })
const TOKEN_KEY = 'gcal_tokens'

export function saveTokens(tokens: object): void {
  const json = JSON.stringify(tokens)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(json)
    store.set(TOKEN_KEY, encrypted.toString('latin1'))
    store.set(`${TOKEN_KEY}_encrypted`, true)
  } else {
    store.set(TOKEN_KEY, json)
    store.set(`${TOKEN_KEY}_encrypted`, false)
  }
}

export function loadTokens(): object | null {
  const raw = store.get(TOKEN_KEY) as string | undefined
  if (!raw) return null

  try {
    const isEncrypted = store.get(`${TOKEN_KEY}_encrypted`) as boolean
    if (isEncrypted && safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(Buffer.from(raw, 'latin1'))
      return JSON.parse(decrypted)
    }
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function clearTokens(): void {
  store.delete(TOKEN_KEY)
  store.delete(`${TOKEN_KEY}_encrypted`)
}
