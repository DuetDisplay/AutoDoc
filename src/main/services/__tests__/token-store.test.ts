import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron modules before importing
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}))

const mockStore = new Map<string, unknown>()
vi.mock('electron-store', () => ({
  default: class {
    get(key: string, fallback?: unknown) { return mockStore.get(key) ?? fallback }
    set(key: string, value: unknown) { mockStore.set(key, value) }
    delete(key: string) { mockStore.delete(key) }
    has(key: string) { return mockStore.has(key) }
  },
}))

import { saveTokensForAccount, loadTokensForAccount, clearTokensForAccount, migrateLegacyTokens } from '../token-store'

beforeEach(() => {
  mockStore.clear()
})

describe('account-scoped token store', () => {
  it('saves and loads tokens for a specific account', () => {
    const tokens = { access_token: 'abc', refresh_token: 'def', expiry_date: 999 }
    saveTokensForAccount('acct-1', tokens)
    const loaded = loadTokensForAccount('acct-1')
    expect(loaded).toEqual(tokens)
  })

  it('returns null for unknown account', () => {
    expect(loadTokensForAccount('unknown')).toBeNull()
  })

  it('clears tokens for a specific account', () => {
    saveTokensForAccount('acct-1', { access_token: 'abc' })
    clearTokensForAccount('acct-1')
    expect(loadTokensForAccount('acct-1')).toBeNull()
  })

  it('isolates tokens between accounts', () => {
    saveTokensForAccount('acct-1', { access_token: 'one' })
    saveTokensForAccount('acct-2', { access_token: 'two' })
    expect(loadTokensForAccount('acct-1')).toEqual({ access_token: 'one' })
    expect(loadTokensForAccount('acct-2')).toEqual({ access_token: 'two' })
  })
})

describe('migrateLegacyTokens', () => {
  it('returns null when no legacy tokens exist', () => {
    expect(migrateLegacyTokens()).toBeNull()
  })

  it('migrates legacy gcal_tokens to account-scoped key', () => {
    const legacyTokens = JSON.stringify({ access_token: 'old', refresh_token: 'old-ref' })
    mockStore.set('gcal_tokens', legacyTokens)
    mockStore.set('gcal_tokens_encrypted', false)

    const accountId = migrateLegacyTokens()
    expect(accountId).toBeTruthy()

    // Legacy key should be deleted
    expect(mockStore.has('gcal_tokens')).toBe(false)

    // New account-scoped key should have the tokens
    const loaded = loadTokensForAccount(accountId!)
    expect(loaded).toEqual({ access_token: 'old', refresh_token: 'old-ref' })
  })
})
