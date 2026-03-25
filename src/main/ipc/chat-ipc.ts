import { ipcMain } from 'electron'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { OllamaManager } from '../services/ollama-manager'
import type { OllamaProvider } from '../services/llm'
import type { Transcript, MeetingSegments } from '../../shared/types'

const CHAT_SYSTEM_PROMPT = `You are AutoDoc's AI assistant. You help users understand their meetings by answering questions based on meeting transcripts and notes.

Rules:
- Answer concisely and directly based on the meeting data provided
- If the answer isn't in the provided context, say so honestly
- Reference specific meetings when relevant
- Use plain language, not jargon`

export function registerChatIpc(
  recordingsBaseDir: string,
  ollamaManager: OllamaManager,
  ollamaProvider: OllamaProvider,
): void {
  ipcMain.handle('chat:send', async (_event, question: string): Promise<string> => {
    // Try waiting for managed Ollama; fall back if server is already running externally
    try {
      await ollamaManager.waitUntilReady()
    } catch {
      const running = await ollamaManager.isServerRunning()
      if (!running) throw new Error('Ollama is not running. Please start Ollama and try again.')
    }

    // Gather context from recent meetings
    const context = await gatherMeetingContext(recordingsBaseDir)

    const res = await fetch(`${ollamaManager.getBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaProvider.getModel(),
        messages: [
          { role: 'system', content: CHAT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Here is context from recent meetings:\n\n${context}\n\n---\n\nUser question: ${question}`,
          },
        ],
        stream: false,
      }),
    })

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}`)
    }

    const data = (await res.json()) as { message?: { content?: string } }
    return data.message?.content ?? 'No response from AI.'
  })
}

async function gatherMeetingContext(recordingsBaseDir: string): Promise<string> {
  let dirs: string[]
  try {
    dirs = await readdir(recordingsBaseDir)
  } catch {
    return 'No meetings found.'
  }

  // Get meeting dirs sorted by date (most recent first)
  const meetings: { id: string; date: number; dir: string }[] = []
  for (const meetingId of dirs) {
    const meetingDir = join(recordingsBaseDir, meetingId)
    const dirStat = await stat(meetingDir).catch(() => null)
    if (!dirStat?.isDirectory()) continue
    const audioStat = await stat(join(meetingDir, 'audio.webm')).catch(() => null)
    if (!audioStat) continue
    meetings.push({ id: meetingId, date: audioStat.birthtime.getTime(), dir: meetingDir })
  }

  meetings.sort((a, b) => b.date - a.date)

  // Include up to 5 most recent meetings
  const contextParts: string[] = []
  for (const meeting of meetings.slice(0, 5)) {
    const dateStr = new Date(meeting.date).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })

    let meetingContext = `## Meeting: ${dateStr}\n`

    // Prefer segments (structured notes) over raw transcript
    try {
      const data = await readFile(join(meeting.dir, 'segments.json'), 'utf-8')
      const segments: MeetingSegments = JSON.parse(data)

      for (const [category, items] of Object.entries(segments)) {
        if (items.length === 0) continue
        meetingContext += `\n### ${category}\n`
        for (const item of items) {
          meetingContext += `- **${item.title}**: ${item.content}\n`
        }
      }
    } catch {
      // Fall back to transcript
      try {
        const data = await readFile(join(meeting.dir, 'transcript.json'), 'utf-8')
        const transcripts: Transcript[] = JSON.parse(data)
        const text = transcripts.map((t) => t.text).join(' ')
        // Truncate long transcripts
        meetingContext += text.slice(0, 2000) + (text.length > 2000 ? '...' : '')
      } catch {
        continue
      }
    }

    contextParts.push(meetingContext)
  }

  return contextParts.length > 0 ? contextParts.join('\n\n---\n\n') : 'No meeting data available.'
}
