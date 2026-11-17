/** Structural preparation status; no meeting content crosses this event. */
export interface AskAiIndexStatus {
  state: 'idle' | 'preparing' | 'paused' | 'ready' | 'unavailable'
  percent: number
  significant: boolean
}
