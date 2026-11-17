import { describe, expect, it } from 'vitest'
import { createSentryEventCap } from '../sentry-event-cap'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function capAt(start = 0) {
  let now = start
  return {
    cap: createSentryEventCap(() => now),
    advance: (ms: number) => {
      now += ms
    }
  }
}

const error = (value: string, type = 'Error') => ({ exception: { values: [{ type, value }] } })

describe('Sentry event cap', () => {
  it('lets the same error through three times a day', () => {
    const { cap, advance } = capAt()

    expect([1, 2, 3, 4].map(() => cap.allow(error('invalid_request')))).toEqual([
      true,
      true,
      true,
      false
    ])
    advance(DAY - 1)
    expect(cap.allow(error('invalid_request'))).toBe(false)
    advance(1)
    expect(cap.allow(error('invalid_request'))).toBe(true)
  })

  it('counts each error separately', () => {
    const { cap } = capAt()
    for (let i = 0; i < 3; i++) cap.allow(error('first'))

    expect(cap.allow(error('first'))).toBe(false)
    expect(cap.allow(error('second'))).toBe(true)
  })

  it('treats errors that differ only by ids, numbers or paths as the same', () => {
    const { cap } = capAt()
    const rename = (id: string) =>
      error(`EPERM: rename '[home]\\recordings\\${id}\\system.webm.enc'`)
    cap.allow(rename('8400e5b8-f7ff-4e4e-9d99-376bad8f69fd'))
    cap.allow(rename('0f04db5e-f1d7-4ac9-b286-08392f1619b0'))
    cap.allow(rename('e89d8c3c-0f16-4a94-b1aa-3d2f323da690'))

    expect(cap.allow(rename('8ce79056-b889-4500-b400-be9ae19db849'))).toBe(false)
  })

  it('counts events with the same fingerprint together', () => {
    const { cap } = capAt()
    const fingerprinted = (value: string) => ({ ...error(value), fingerprint: ['disk-full'] })
    cap.allow(fingerprinted('ENOSPC: write'))
    cap.allow(fingerprinted('ffmpeg: No space left on device'))
    cap.allow(fingerprinted('ENOSPC: open'))

    expect(cap.allow(fingerprinted('ENOSPC: rename'))).toBe(false)
  })

  it('counts plain messages like errors', () => {
    const { cap } = capAt()
    for (let i = 0; i < 3; i++) cap.allow({ message: 'Recording stopped early' })

    expect(cap.allow({ message: 'Recording stopped early' })).toBe(false)
  })

  it('limits everything to 20 events an hour, however varied', () => {
    const { cap, advance } = capAt()
    const allowed = Array.from({ length: 25 }, (_, i) =>
      cap.allow(error(`failure kind ${String.fromCharCode(97 + i)}`))
    )

    expect(allowed.filter(Boolean)).toHaveLength(20)
    advance(HOUR)
    expect(cap.allow(error('a later failure'))).toBe(true)
  })

  it('does not spend the hourly limit on events it dropped', () => {
    const { cap } = capAt()
    for (let i = 0; i < 30; i++) cap.allow(error('same failure'))

    expect(cap.allow(error('a different failure'))).toBe(true)
  })
})
