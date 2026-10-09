import { logAutodocEvent } from './autodoc-log'

export const OLLAMA_START_FAILURE_PAUSE_THRESHOLD = 5

let consecutiveFailures = 0
let backgroundRestartsPaused = false
let pauseLogged = false

export function recordOllamaStartSuccess(): void {
  consecutiveFailures = 0
  backgroundRestartsPaused = false
  pauseLogged = false
}

export function recordOllamaStartFailure(): void {
  consecutiveFailures += 1
  if (consecutiveFailures < OLLAMA_START_FAILURE_PAUSE_THRESHOLD) return
  backgroundRestartsPaused = true
  if (pauseLogged) return
  pauseLogged = true
  logAutodocEvent({
    area: 'ollama',
    message: 'ollama restarts paused after repeated start failures'
  })
}

export function areBackgroundOllamaRestartsPaused(): boolean {
  return backgroundRestartsPaused
}

export function getOllamaStartFailureStreak(): number {
  return consecutiveFailures
}

export function resetOllamaStartFailureStreak(): void {
  consecutiveFailures = 0
  backgroundRestartsPaused = false
  pauseLogged = false
}
