import { safeStorage } from 'electron'
import ElectronStoreModule from 'electron-store'

const Store =
  (ElectronStoreModule as unknown as { default?: typeof ElectronStoreModule }).default ??
  ElectronStoreModule

let _store: InstanceType<typeof Store> | null = null
function getStore(): InstanceType<typeof Store> {
  if (!_store) _store = new Store({ name: 'autodoc-tokens' })
  return _store
}

const TOKEN_KEY = 'gcal_tokens'

export function saveTokens(tokens: object): void {
  const json = JSON.stringify(tokens)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(json)
    getStore().set(TOKEN_KEY, encrypted.toString('latin1'))
    getStore().set(`${TOKEN_KEY}_encrypted`, true)
  } else {
    getStore().set(TOKEN_KEY, json)
    getStore().set(`${TOKEN_KEY}_encrypted`, false)
  }
}

export function loadTokens(): object | null {
  const raw = getStore().get(TOKEN_KEY) as string | undefined
  if (!raw) return null

  try {
    const isEncrypted = getStore().get(`${TOKEN_KEY}_encrypted`) as boolean
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
  getStore().delete(TOKEN_KEY)
  getStore().delete(`${TOKEN_KEY}_encrypted`)
}
