import Store from 'electron-store'
import { migrateLegacyTokens, hasTokensForAccount, loadTokensForAccount } from './token-store'
import { GoogleCalendarProvider } from './calendar'
import { MicrosoftCalendarProvider } from './microsoft-calendar'
import type { CalendarProvider } from './calendar-types'
import { dedupeCalendarEvents, getCalendarAccountIdentity, isPlaceholderCalendarEmail, isSameCalendarAccount } from './calendar-dedupe'
import type { CalendarAccount, CalendarEvent, OAuthTokens } from '../../shared/types'
import { logAutodocFailure } from './autodoc-log'
import { captureMessage } from './sentry-reporter'
import {
  isTransientCalendarError,
  isUnsupportedMicrosoftMailboxError,
  isCalendarTransientError,
  isUnsupportedCalendarAccountError
} from './calendar-error-classification'

const accountStore = new Store<{ accounts: CalendarAccount[] }>({ name: 'autodoc-calendar-accounts' })

export class CalendarManager {
  private providers: Map<string, CalendarProvider>
  private accounts: CalendarAccount[] = []
  private syncInterval: ReturnType<typeof setInterval> | null = null
  private connecting = false
  private syncing = false

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
      let email = ''
      try {
        email = (await googleProvider.fetchAccountEmail(migratedAccountId)) ?? ''
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

    // Step 3: Validate each has tokens, remove orphans, and collapse duplicate accounts.
    const validAccounts = saved.filter((account) => hasTokensForAccount(account.id))
    const hydratedAccounts = await this.refreshUnknownAccountEmails(validAccounts)
    this.accounts = await this.removeDuplicateAccounts(hydratedAccounts)

    if (migratedAccountId || JSON.stringify(saved) !== JSON.stringify(this.accounts)) {
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
      const accountTokens = this.getAccountTokens(account.id)
      const replacedAccounts = this.accounts.filter((existing) =>
        isSameCalendarAccount(existing, account, this.getAccountTokens(existing.id), accountTokens)
      )
      for (const existing of replacedAccounts) {
        const existingProvider = this.providers.get(existing.provider)
        await existingProvider?.disconnect(existing.id)
      }

      this.accounts = this.accounts.filter((existing) =>
        !isSameCalendarAccount(existing, account, this.getAccountTokens(existing.id), accountTokens)
      )
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
    const syncableAccounts = this.accounts.filter((account) => account.syncIssue == null)
    if (syncableAccounts.length === 0) return []

    const results = await Promise.allSettled(
      syncableAccounts.map(async (account) => {
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
        const account = syncableAccounts[i]
        if (
          isUnsupportedCalendarAccountError(result.reason) ||
          isUnsupportedMicrosoftMailboxError(result.reason)
        ) {
          await this.markAccountSyncIssue(account?.id, 'unsupported-mailbox')
          console.warn(
            `Disabled calendar sync for unsupported account ${account?.email ?? account?.provider ?? 'unknown'}`
          )
          continue
        }
        if (isCalendarTransientError(result.reason) || isTransientCalendarError(result.reason)) {
          console.warn(
            `Transient calendar fetch failure for ${account?.email ?? account?.provider ?? 'unknown'}:`,
            result.reason
          )
          continue
        }
        console.error(`Failed to fetch events for account ${account?.email ?? account?.provider ?? 'unknown'}:`, result.reason)
        logAutodocFailure({
          area: 'calendar',
          message: 'Failed to fetch upcoming calendar events for account',
          error: result.reason,
          context: {
            provider: account?.provider ?? 'unknown',
            accountIndex: i,
          },
        })
      }
    }

    return dedupeCalendarEvents(events)
  }

  async fetchAllRecentEvents(daysBack = 7): Promise<CalendarEvent[]> {
    const syncableAccounts = this.accounts.filter((account) => account.syncIssue == null)
    if (syncableAccounts.length === 0) return []

    const results = await Promise.allSettled(
      syncableAccounts.map(async (account) => {
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
        const account = syncableAccounts[i]
        if (
          isUnsupportedCalendarAccountError(result.reason) ||
          isUnsupportedMicrosoftMailboxError(result.reason)
        ) {
          await this.markAccountSyncIssue(account?.id, 'unsupported-mailbox')
          console.warn(
            `Disabled calendar sync for unsupported account ${account?.email ?? account?.provider ?? 'unknown'}`
          )
          continue
        }
        if (isCalendarTransientError(result.reason) || isTransientCalendarError(result.reason)) {
          console.warn(
            `Transient recent-calendar fetch failure for ${account?.email ?? account?.provider ?? 'unknown'}:`,
            result.reason
          )
          continue
        }
        console.error(`Failed to fetch recent events for account ${account?.email ?? account?.provider ?? 'unknown'}:`, result.reason)
        logAutodocFailure({
          area: 'calendar',
          message: 'Failed to fetch recent calendar events for account',
          error: result.reason,
          context: {
            provider: account?.provider ?? 'unknown',
            accountIndex: i,
          },
        })
      }
    }

    return dedupeCalendarEvents(events)
  }

  startSync(callback: (events: CalendarEvent[]) => void): void {
    // Fetch immediately
    this.fetchAllUpcomingEvents()
      .then(callback)
      .catch((err) => {
        console.error('Initial calendar sync failed:', err)
        logAutodocFailure({
          area: 'calendar',
          message: 'Initial calendar sync failed',
          error: err,
          context: { accountCount: this.accounts.length },
        })
      })

    // Then every 5 minutes
    this.syncInterval = setInterval(async () => {
      if (this.syncing) return
      this.syncing = true
      try {
        const events = await this.fetchAllUpcomingEvents()
        callback(events)
      } catch (err) {
        console.error('Calendar sync failed:', err)
        logAutodocFailure({
          area: 'calendar',
          message: 'Scheduled calendar sync failed',
          error: err,
          context: { accountCount: this.accounts.length },
        })
      } finally {
        this.syncing = false
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

  private async markAccountSyncIssue(
    accountId: string | undefined,
    syncIssue: CalendarAccount['syncIssue']
  ): Promise<void> {
    if (!accountId) {
      return
    }

    let changed = false
    this.accounts = this.accounts.map((account) => {
      if (account.id !== accountId || account.syncIssue === syncIssue) {
        return account
      }

      changed = true
      return {
        ...account,
        syncIssue
      }
    })

    if (changed) {
      this.saveAccounts()
      captureMessage('Unsupported Microsoft mailbox disabled for calendar sync', {
        area: 'calendar',
        level: 'info',
        tags: {
          provider: 'microsoft',
          calendar_sync_issue: syncIssue ?? 'none'
        },
        extra: {
          accountId,
          syncIssue
        }
      })
    }
  }

  private getAccountTokens(accountId: string): Partial<OAuthTokens> | null {
    return loadTokensForAccount(accountId) as Partial<OAuthTokens> | null
  }

  private async refreshUnknownAccountEmails(accounts: CalendarAccount[]): Promise<CalendarAccount[]> {
    return await Promise.all(
      accounts.map(async (account) => {
        if (!isPlaceholderCalendarEmail(account.email)) {
          return account
        }

        const provider = this.providers.get(account.provider)
        if (!provider) {
          return account
        }

        try {
          const email = (await provider.fetchAccountEmail(account.id)) ?? ''
          return email === account.email ? account : { ...account, email }
        } catch {
          return account.email ? { ...account, email: '' } : account
        }
      }),
    )
  }

  private async removeDuplicateAccounts(accounts: CalendarAccount[]): Promise<CalendarAccount[]> {
    const identities = new Set<string>()
    const accountsByPriority = [...accounts].sort((a, b) => b.connectedAt - a.connectedAt)
    const uniqueAccounts: CalendarAccount[] = []
    const duplicateAccounts: CalendarAccount[] = []

    for (const account of accountsByPriority) {
      const identity = getCalendarAccountIdentity(account, this.getAccountTokens(account.id))
      if (identity && identities.has(identity)) {
        duplicateAccounts.push(account)
        continue
      }

      if (identity) identities.add(identity)
      uniqueAccounts.push(account)
    }

    for (const duplicate of duplicateAccounts) {
      const provider = this.providers.get(duplicate.provider)
      await provider?.disconnect(duplicate.id)
    }

    return uniqueAccounts.sort((a, b) => a.connectedAt - b.connectedAt)
  }
}
