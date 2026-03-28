import Store from 'electron-store'
import { migrateLegacyTokens, hasTokensForAccount } from './token-store'
import { GoogleCalendarProvider } from './calendar'
import { MicrosoftCalendarProvider } from './microsoft-calendar'
import type { CalendarProvider } from './calendar-types'
import type { CalendarAccount, CalendarEvent } from '../../shared/types'

const accountStore = new Store<{ accounts: CalendarAccount[] }>({ name: 'autodoc-calendar-accounts' })

export class CalendarManager {
  private providers: Map<string, CalendarProvider>
  private accounts: CalendarAccount[] = []
  private syncInterval: ReturnType<typeof setInterval> | null = null
  private connecting = false

  constructor() {
    this.providers = new Map<string, CalendarProvider>([
      ['google', new GoogleCalendarProvider()],
      ['microsoft', new MicrosoftCalendarProvider()],
    ])
  }

  getAccounts(): CalendarAccount[] {
    return [...this.accounts]
  }

  isConnected(): boolean {
    return this.accounts.length > 0
  }

  async initialize(): Promise<CalendarAccount[]> {
    // Step 1: Load saved accounts
    const saved = accountStore.get('accounts', []) as CalendarAccount[]

    // Step 2: Migrate legacy gcal_tokens if present (and no saved accounts yet)
    const migratedAccountId = migrateLegacyTokens()
    if (migratedAccountId) {
      const googleProvider = this.providers.get('google') as GoogleCalendarProvider

      // Fetch email for the migrated account (best effort)
      let email = 'unknown@gmail.com'
      try {
        email = await googleProvider.fetchUserEmail(migratedAccountId)
      } catch {
        // Token might be expired — email will show as unknown, user can reconnect
      }

      const migratedAccount: CalendarAccount = {
        id: migratedAccountId,
        provider: 'google',
        email,
        connectedAt: Date.now(),
      }

      saved.push(migratedAccount)
      console.log('Migrated legacy Google Calendar account:', migratedAccountId, email)
    }

    // Step 3: Validate each has tokens, remove orphans
    this.accounts = saved.filter((account) => hasTokensForAccount(account.id))

    if (this.accounts.length !== saved.length || migratedAccountId) {
      this.saveAccounts()
    }

    return this.getAccounts()
  }

  async connect(providerType: 'google' | 'microsoft'): Promise<CalendarAccount> {
    if (this.connecting) {
      throw new Error('Another calendar connection is already in progress')
    }

    this.connecting = true
    try {
      const provider = this.providers.get(providerType)
      if (!provider) throw new Error(`Unknown provider: ${providerType}`)

      const account = await provider.connect()
      this.accounts.push(account)
      this.saveAccounts()
      return account
    } finally {
      this.connecting = false
    }
  }

  async disconnect(accountId: string): Promise<void> {
    const account = this.accounts.find((a) => a.id === accountId)
    if (!account) return

    const provider = this.providers.get(account.provider)
    if (provider) {
      await provider.disconnect(accountId)
    }

    this.accounts = this.accounts.filter((a) => a.id !== accountId)
    this.saveAccounts()
  }

  async fetchAllUpcomingEvents(): Promise<CalendarEvent[]> {
    if (this.accounts.length === 0) return []

    const results = await Promise.allSettled(
      this.accounts.map(async (account) => {
        const provider = this.providers.get(account.provider)
        if (!provider) return []
        return provider.fetchUpcomingEvents(account.id)
      })
    )

    const events: CalendarEvent[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        events.push(...result.value)
      } else {
        console.error(`Failed to fetch events for account ${this.accounts[i].email}:`, result.reason)
      }
    }

    return events.sort((a, b) => a.startTime - b.startTime)
  }

  async fetchAllRecentEvents(daysBack = 7): Promise<CalendarEvent[]> {
    if (this.accounts.length === 0) return []

    const results = await Promise.allSettled(
      this.accounts.map(async (account) => {
        const provider = this.providers.get(account.provider)
        if (!provider) return []
        return provider.fetchRecentEvents(account.id, daysBack)
      })
    )

    const events: CalendarEvent[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        events.push(...result.value)
      } else {
        console.error(`Failed to fetch recent events for account ${this.accounts[i].email}:`, result.reason)
      }
    }

    return events.sort((a, b) => a.startTime - b.startTime)
  }

  startSync(callback: (events: CalendarEvent[]) => void): void {
    // Fetch immediately
    this.fetchAllUpcomingEvents()
      .then(callback)
      .catch((err) => console.error('Initial calendar sync failed:', err))

    // Then every 5 minutes
    this.syncInterval = setInterval(async () => {
      try {
        const events = await this.fetchAllUpcomingEvents()
        callback(events)
      } catch (err) {
        console.error('Calendar sync failed:', err)
      }
    }, 5 * 60 * 1000)
  }

  stopSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval)
      this.syncInterval = null
    }
  }

  private saveAccounts(): void {
    accountStore.set('accounts', this.accounts)
  }
}
