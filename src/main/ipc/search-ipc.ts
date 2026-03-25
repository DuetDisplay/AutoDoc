import { ipcMain } from 'electron'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { Transcript, MeetingSegments } from '../../shared/types'
import { decryptJSON, isEncrypted } from '../services/crypto'

export interface SearchResult {
  meetingId: string
  title: string
  date: number
  matches: { type: 'transcript' | 'segment'; text: string; category?: string }[]
}

export function registerSearchIpc(recordingsBaseDir: string): void {
  ipcMain.handle('search:query', async (_event, query: string): Promise<SearchResult[]> => {
    if (!query.trim()) return []

    const terms = query.toLowerCase().split(/\s+/)
    let dirs: string[]
    try {
      dirs = await readdir(recordingsBaseDir)
    } catch {
      return []
    }

    const results: SearchResult[] = []

    for (const meetingId of dirs) {
      const meetingDir = join(recordingsBaseDir, meetingId)
      const dirStat = await stat(meetingDir).catch(() => null)
      if (!dirStat?.isDirectory()) continue

      const matches: SearchResult['matches'] = []

      // Search transcripts
      try {
        const tPath = join(meetingDir, 'transcript.json')
        const transcripts: Transcript[] = await isEncrypted(tPath)
          ? await decryptJSON<Transcript[]>(tPath)
          : JSON.parse(await readFile(tPath, 'utf-8'))
        for (const seg of transcripts) {
          const lower = seg.text.toLowerCase()
          if (terms.every((t) => lower.includes(t))) {
            matches.push({ type: 'transcript', text: seg.text })
          }
        }
      } catch { /* no transcript */ }

      // Search segments
      try {
        const sPath = join(meetingDir, 'segments.json')
        const segments: MeetingSegments = await isEncrypted(sPath)
          ? await decryptJSON<MeetingSegments>(sPath)
          : JSON.parse(await readFile(sPath, 'utf-8'))
        for (const [category, items] of Object.entries(segments)) {
          for (const item of items) {
            const combined = `${item.title} ${item.content}`.toLowerCase()
            if (terms.every((t) => combined.includes(t))) {
              matches.push({ type: 'segment', text: `${item.title}: ${item.content}`, category })
            }
          }
        }
      } catch { /* no segments */ }

      if (matches.length > 0) {
        const audioStat = await stat(join(meetingDir, 'audio.webm')).catch(() => null)
        const createdAt = audioStat?.birthtime ?? new Date()

        results.push({
          meetingId,
          title: `Recording ${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
          date: createdAt.getTime(),
          matches: matches.slice(0, 5), // Cap at 5 matches per meeting
        })
      }
    }

    return results.sort((a, b) => b.date - a.date)
  })
}
