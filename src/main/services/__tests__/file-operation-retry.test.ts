import { afterEach, describe, expect, it, vi } from 'vitest'

const { rename } = vi.hoisted(() => ({ rename: vi.fn() }))

vi.mock('fs/promises', () => ({ rename, unlink: vi.fn() }))

import { renameWithRetry } from '../file-operation-retry'

const realPlatform = process.platform

describe('renameWithRetry', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: realPlatform })
  })

  it('groups a rename that stays locked by its error code, whatever the path', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    rename.mockRejectedValue(
      Object.assign(new Error("EPERM: rename 'a\\3ebdee46\\system.webm.enc'"), { code: 'EPERM' })
    )

    await expect(renameWithRetry('from', 'to', [])).rejects.toMatchObject({
      sentryFingerprint: ['file-rename-failed', 'EPERM']
    })
  })
})
