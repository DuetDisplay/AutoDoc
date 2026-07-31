import { describe, expect, it, vi } from 'vitest'
import {
  FeedbackPromptStore,
  createDefaultFeedbackPromptState,
  type FeedbackPromptEncryption,
  type FeedbackPromptStoreBackend
} from '../feedback-prompt-store'

class MemoryBackend implements FeedbackPromptStoreBackend {
  readonly values = new Map<string, unknown>()
  get = vi.fn((key: 'state') => this.values.get(key))
  set = vi.fn((key: 'state', value: string) => {
    this.values.set(key, value)
  })
}

function createEncryption(available = true): FeedbackPromptEncryption {
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf8')),
    decryptString: vi.fn((ciphertext: Buffer) => {
      const serialized = ciphertext.toString('utf8')
      if (!serialized.startsWith('encrypted:')) throw new Error('Invalid ciphertext')
      return serialized.slice('encrypted:'.length)
    })
  }
}

function encodeState(state: unknown): string {
  return Buffer.from(`encrypted:${JSON.stringify(state)}`, 'utf8').toString('base64')
}

describe('FeedbackPromptStore', () => {
  it('uses logical defaults without persisting plaintext on first read', async () => {
    const backend = new MemoryBackend()
    const encryption = createEncryption()
    const store = new FeedbackPromptStore({ backend, encryption })

    await expect(store.readState()).resolves.toEqual(createDefaultFeedbackPromptState())
    expect(backend.set).not.toHaveBeenCalled()
  })

  it('persists only a canonical base64 safeStorage ciphertext', async () => {
    const backend = new MemoryBackend()
    const encryption = createEncryption()
    const store = new FeedbackPromptStore({ backend, encryption })

    await store.updateState((state) => ({
      ...state,
      qualifyingSessionCount: 1,
      qualifyingSessionDates: ['2026-07-31'],
      lastQualifiedSessionAt: 123
    }))

    expect(encryption.encryptString).toHaveBeenCalledOnce()
    const raw = backend.values.get('state')
    expect(typeof raw).toBe('string')
    expect(raw).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(raw).not.toContain('qualifyingSessionCount')
    await expect(store.readState()).resolves.toMatchObject({
      qualifyingSessionCount: 1,
      qualifyingSessionDates: ['2026-07-31'],
      lastQualifiedSessionAt: 123
    })
  })

  it('never falls back to plaintext when safeStorage is unavailable', async () => {
    const backend = new MemoryBackend()
    let available = false
    const encryption = createEncryption()
    vi.mocked(encryption.isEncryptionAvailable).mockImplementation(() => available)
    const store = new FeedbackPromptStore({ backend, encryption })

    await expect(
      store.updateState((state) => ({ ...state, neverAskAgain: true }))
    ).resolves.toBeNull()
    expect(backend.set).not.toHaveBeenCalled()
    expect(store.isAvailable()).toBe(false)

    available = true
    await expect(store.readState()).resolves.toBeNull()
    expect(encryption.encryptString).not.toHaveBeenCalled()
  })

  it('fails closed for corrupt ciphertext and remains circuit-broken', async () => {
    const backend = new MemoryBackend()
    backend.values.set('state', 'not base64')
    const store = new FeedbackPromptStore({ backend, encryption: createEncryption() })

    await expect(store.readState()).resolves.toBeNull()
    expect(store.isAvailable()).toBe(false)

    backend.values.set('state', encodeState(createDefaultFeedbackPromptState()))
    await expect(store.readState()).resolves.toBeNull()
  })

  it('fails closed when safeStorage cannot decrypt canonical ciphertext', async () => {
    const backend = new MemoryBackend()
    backend.values.set('state', Buffer.from('encrypted bytes').toString('base64'))
    const encryption = createEncryption()
    vi.mocked(encryption.decryptString).mockImplementation(() => {
      throw new Error('Keychain entry is unavailable')
    })
    const store = new FeedbackPromptStore({ backend, encryption })

    await expect(store.readState()).resolves.toBeNull()
    expect(store.isAvailable()).toBe(false)
  })

  it('fails closed for decrypted JSON with an invalid schema', async () => {
    const backend = new MemoryBackend()
    backend.values.set(
      'state',
      encodeState({ ...createDefaultFeedbackPromptState(), schemaVersion: 999 })
    )
    const store = new FeedbackPromptStore({ backend, encryption: createEncryption() })

    await expect(store.readState()).resolves.toBeNull()
    expect(store.isAvailable()).toBe(false)
  })

  it('circuit-breaks quietly after encryption or persistence fails', async () => {
    const backend = new MemoryBackend()
    const encryption = createEncryption()
    vi.mocked(encryption.encryptString).mockImplementation(() => {
      throw new Error('Keychain failure')
    })
    const store = new FeedbackPromptStore({ backend, encryption })

    await expect(
      store.updateState((state) => ({ ...state, neverAskAgain: true }))
    ).resolves.toBeNull()
    await expect(store.readState()).resolves.toBeNull()
    expect(backend.set).not.toHaveBeenCalled()
  })

  it('circuit-breaks quietly after the atomic backend write fails', async () => {
    const backend = new MemoryBackend()
    backend.set.mockImplementation(() => {
      throw new Error('Disk full')
    })
    const store = new FeedbackPromptStore({ backend, encryption: createEncryption() })

    await expect(
      store.updateState((state) => ({ ...state, neverAskAgain: true }))
    ).resolves.toBeNull()
    expect(store.isAvailable()).toBe(false)
    await expect(store.readState()).resolves.toBeNull()
  })

  it('serializes concurrent read-modify-write updates without losing increments', async () => {
    const backend = new MemoryBackend()
    const store = new FeedbackPromptStore({ backend, encryption: createEncryption() })

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.updateState((state) => ({
          ...state,
          qualifyingSessionCount: state.qualifyingSessionCount + 1,
          qualifyingSessionDates: ['2026-07-31'],
          lastQualifiedSessionAt: index + 1
        }))
      )
    )

    await expect(store.readState()).resolves.toMatchObject({
      qualifyingSessionCount: 25,
      qualifyingSessionDates: ['2026-07-31']
    })
    expect(backend.set).toHaveBeenCalledTimes(25)
  })

  it('does not rewrite encrypted state for a no-op mutation', async () => {
    const backend = new MemoryBackend()
    const store = new FeedbackPromptStore({ backend, encryption: createEncryption() })

    await expect(store.updateState((state) => state)).resolves.toEqual(
      createDefaultFeedbackPromptState()
    )
    expect(backend.set).not.toHaveBeenCalled()
  })
})
