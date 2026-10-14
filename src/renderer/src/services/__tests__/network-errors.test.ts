import { describe, expect, it } from 'vitest'
import { isNetworkErrorMessage } from '../network-errors'
import { offlineMeetingLanguageMessage } from '../meeting-language-copy'

describe('isNetworkErrorMessage', () => {
  it('recognizes connection failures, including IPC-wrapped ones', () => {
    for (const message of [
      'fetch failed',
      "Error invoking remote method 'whisper:prepare-meeting-language': TypeError: fetch failed",
      'getaddrinfo ENOTFOUND huggingface.co',
      'connect ECONNREFUSED 127.0.0.1:9',
      'read ECONNRESET',
      'connect ETIMEDOUT 140.82.112.3:443'
    ]) {
      expect(isNetworkErrorMessage(message), message).toBe(true)
    }
  })

  it('leaves other failures alone', () => {
    for (const message of [
      'Failed to download speech model: 404 Not Found',
      'Disk is full.',
      'Spanish needs a supported graphics card on this PC.',
      null,
      undefined,
      ''
    ]) {
      expect(isNetworkErrorMessage(message), String(message)).toBe(false)
    }
  })
})

describe('offlineMeetingLanguageMessage', () => {
  it('names the language, the download size and the language still in use', () => {
    expect(offlineMeetingLanguageMessage('Japanese', 1_613_977_880, 'English')).toBe(
      "You're offline. Connect to the internet to download the Japanese speech model (about 1.5 GB). Your meeting language is still English."
    )
  })

  it('omits unknown sizes and languages', () => {
    expect(offlineMeetingLanguageMessage('German')).toBe(
      "You're offline. Connect to the internet to download the German speech model."
    )
  })
})
