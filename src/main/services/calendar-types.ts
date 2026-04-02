import type { CalendarAccount, CalendarEvent } from '../../shared/types'

export interface CalendarProvider {
  readonly providerType: 'google' | 'microsoft'

  connect(): Promise<CalendarAccount>
  disconnect(accountId: string): Promise<void>
  isConnected(accountId: string): boolean
  fetchAccountEmail(accountId: string): Promise<string | null>

  fetchUpcomingEvents(accountId: string): Promise<CalendarEvent[]>
  fetchRecentEvents(accountId: string, daysBack: number): Promise<CalendarEvent[]>
  refreshTokens(accountId: string): Promise<void>
}
