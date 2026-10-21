import { logAutodocEvent } from './autodoc-log'

export const OLLAMA_POST_WAKE_FAILURE_PAUSE_THRESHOLD = 3

let consecutiveStartFailures = 0
let consecutiveWakeFailures = 0
let backgroundRestartsPaused = false
let pauseLogged = false

function clearWakePause(): void {
  consecutiveWakeFailures = 0
  backgroundRestartsPaused = false
  pauseLogged = false
}

function pauseAfterRepeatedWakeFailures(): void {
  backgroundRestartsPaused = true
  if (pauseLogged) return
  pauseLogged = true
  logAutodocEvent({
    area: 'ollama',
    message: 'ollama restarts paused after repeated start failures'
  })
}

export function recordOllamaStartSuccess(): void {
  consecutiveStartFailures = 0
}

export function recordOllamaStartFailure(): void {
  consecutiveStartFailures += 1
}

export function recordOllamaPostWakeCheckSucceeded(): void {
  clearWakePause()
}

export function recordOllamaServeStable(): void {
  clearWakePause()
}

export function recordOllamaPostWakeCheckFailed(): void {
  consecutiveWakeFailures += 1
  if (consecutiveWakeFailures < OLLAMA_POST_WAKE_FAILURE_PAUSE_THRESHOLD) return
  pauseAfterRepeatedWakeFailures()
}

export function areBackgroundOllamaRestartsPaused(): boolean {
  return backgroundRestartsPaused
}

export function getOllamaStartFailureStreak(): number {
  return consecutiveStartFailures
}

export function resetOllamaStartFailureStreak(): void {
  consecutiveStartFailures = 0
  clearWakePause()
}
