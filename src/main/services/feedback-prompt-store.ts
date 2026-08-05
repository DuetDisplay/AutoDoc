import Store from 'electron-store'
import { safeStorage } from 'electron'

export const FEEDBACK_PROMPT_SCHEMA_VERSION = 1
export const MAX_QUALIFYING_SESSION_DATES = 30

const ENCRYPTED_STATE_KEY = 'state'
const MAX_CIPHERTEXT_LENGTH = 128 * 1024
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export interface FeedbackPromptState {
  schemaVersion: typeof FEEDBACK_PROMPT_SCHEMA_VERSION
  qualifyingSessionCount: number
  qualifyingSessionDates: string[]
  lastQualifiedSessionAt: number | null
  initialPromptShownAt: number | null
  reminderPromptShownAt: number | null
  contactInitiatedAt: number | null
  neverAskAgain: boolean
}

interface EncryptedFeedbackPromptSchema {
  state?: string
}

export interface FeedbackPromptStoreBackend {
  get(key: typeof ENCRYPTED_STATE_KEY): unknown
  set(key: typeof ENCRYPTED_STATE_KEY, value: string): void
}

export interface FeedbackPromptEncryption {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

export interface FeedbackPromptStoreOptions {
  backend?: FeedbackPromptStoreBackend
  encryption?: FeedbackPromptEncryption
}

export function createDefaultFeedbackPromptState(): FeedbackPromptState {
  return {
    schemaVersion: FEEDBACK_PROMPT_SCHEMA_VERSION,
    qualifyingSessionCount: 0,
    qualifyingSessionDates: [],
    lastQualifiedSessionAt: null,
    initialPromptShownAt: null,
    reminderPromptShownAt: null,
    contactInitiatedAt: null,
    neverAskAgain: false
  }
}

function isTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isValidLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = LOCAL_DATE_PATTERN.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(Date.UTC(year, month - 1, day))
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  )
}

export function isFeedbackPromptState(value: unknown): value is FeedbackPromptState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const state = value as Partial<FeedbackPromptState>
  if (state.schemaVersion !== FEEDBACK_PROMPT_SCHEMA_VERSION) return false
  if (
    !Number.isSafeInteger(state.qualifyingSessionCount) ||
    (state.qualifyingSessionCount ?? -1) < 0
  ) {
    return false
  }
  if (
    !Array.isArray(state.qualifyingSessionDates) ||
    state.qualifyingSessionDates.length > MAX_QUALIFYING_SESSION_DATES ||
    !state.qualifyingSessionDates.every(isValidLocalDate) ||
    new Set(state.qualifyingSessionDates).size !== state.qualifyingSessionDates.length
  ) {
    return false
  }
  if ((state.qualifyingSessionCount ?? 0) < state.qualifyingSessionDates.length) return false
  if (!isTimestamp(state.lastQualifiedSessionAt)) return false
  if (!isTimestamp(state.initialPromptShownAt)) return false
  if (!isTimestamp(state.reminderPromptShownAt)) return false
  if (!isTimestamp(state.contactInitiatedAt)) return false
  if (typeof state.neverAskAgain !== 'boolean') return false
  if ((state.qualifyingSessionCount ?? 0) === 0 && state.lastQualifiedSessionAt !== null) {
    return false
  }
  if ((state.qualifyingSessionCount ?? 0) > 0 && state.lastQualifiedSessionAt === null) {
    return false
  }
  if (state.reminderPromptShownAt !== null && state.initialPromptShownAt === null) return false

  return true
}

function cloneState(state: FeedbackPromptState): FeedbackPromptState {
  return {
    ...state,
    qualifyingSessionDates: [...state.qualifyingSessionDates]
  }
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_CIPHERTEXT_LENGTH ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return false
  }

  try {
    return Buffer.from(value, 'base64').toString('base64') === value
  } catch {
    return false
  }
}

/**
 * Stores feedback-prompt state as one safeStorage ciphertext. Any persistence or
 * validation failure disables the store for the rest of the process so callers
 * fail closed instead of recreating state and accidentally prompting again.
 */
export class FeedbackPromptStore {
  private backend: FeedbackPromptStoreBackend | null | undefined
  private readonly injectedBackend?: FeedbackPromptStoreBackend
  private readonly encryption: FeedbackPromptEncryption
  private disabled = false
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(options: FeedbackPromptStoreOptions = {}) {
    this.injectedBackend = options.backend
    this.encryption = options.encryption ?? safeStorage
  }

  isAvailable(): boolean {
    return !this.disabled
  }

  async readState(): Promise<FeedbackPromptState | null> {
    return await this.enqueue(() => this.readStateUnserialized())
  }

  async updateState(
    mutate: (current: FeedbackPromptState) => FeedbackPromptState
  ): Promise<FeedbackPromptState | null> {
    return await this.enqueue(() => {
      const current = this.readStateUnserialized()
      if (!current) return null

      let next: FeedbackPromptState
      try {
        next = mutate(cloneState(current))
      } catch {
        this.disabled = true
        return null
      }

      if (!isFeedbackPromptState(next)) {
        this.disabled = true
        return null
      }

      if (JSON.stringify(next) === JSON.stringify(current)) {
        return cloneState(current)
      }

      try {
        if (!this.encryption.isEncryptionAvailable()) {
          this.disabled = true
          return null
        }
        const ciphertext = this.encryption.encryptString(JSON.stringify(next)).toString('base64')
        this.getBackend().set(ENCRYPTED_STATE_KEY, ciphertext)
        return cloneState(next)
      } catch {
        this.disabled = true
        return null
      }
    })
  }

  private async enqueue<T>(operation: () => T): Promise<T> {
    let resolveResult!: (value: T) => void
    const result = new Promise<T>((resolve) => {
      resolveResult = resolve
    })

    this.operationQueue = this.operationQueue
      .then(() => {
        resolveResult(operation())
      })
      .catch(() => {
        this.disabled = true
        resolveResult(null as T)
      })

    await this.operationQueue
    return await result
  }

  private getBackend(): FeedbackPromptStoreBackend {
    if (this.injectedBackend) return this.injectedBackend
    if (this.backend) return this.backend
    if (this.backend === null) throw new Error('Feedback prompt store is unavailable')

    try {
      this.backend = new Store<EncryptedFeedbackPromptSchema>({
        name: 'autodoc-feedback-prompt',
        clearInvalidConfig: false
      }) as FeedbackPromptStoreBackend
      return this.backend
    } catch (error) {
      this.backend = null
      throw error
    }
  }

  private readStateUnserialized(): FeedbackPromptState | null {
    if (this.disabled) return null

    try {
      if (!this.encryption.isEncryptionAvailable()) {
        this.disabled = true
        return null
      }

      const raw = this.getBackend().get(ENCRYPTED_STATE_KEY)
      if (raw === undefined) {
        return createDefaultFeedbackPromptState()
      }
      if (typeof raw !== 'string' || !isCanonicalBase64(raw)) {
        this.disabled = true
        return null
      }

      const plaintext = this.encryption.decryptString(Buffer.from(raw, 'base64'))
      const parsed: unknown = JSON.parse(plaintext)
      if (!isFeedbackPromptState(parsed)) {
        this.disabled = true
        return null
      }

      return cloneState(parsed)
    } catch {
      this.disabled = true
      return null
    }
  }
}
