import { ipcMain } from 'electron'
import { MeetingIndexService } from '../services/meeting-index'

export interface SearchResult {
  meetingId: string
  title: string
  date: number
  matches: { type: 'transcript' | 'segment'; text: string; category?: string; startMs?: number }[]
}

export function registerSearchIpc(
  recordingsBaseDir: string,
  meetingIndex: MeetingIndexService = new MeetingIndexService(recordingsBaseDir)
): void {
  ipcMain.handle('search:query', async (_event, query: string): Promise<SearchResult[]> => {
    if (!query.trim()) return []
    return meetingIndex.query(query)
  })

  ipcMain.handle('search:invalidate', (_event, meetingId?: string): void => {
    meetingIndex.invalidate(meetingId)
  })
}
