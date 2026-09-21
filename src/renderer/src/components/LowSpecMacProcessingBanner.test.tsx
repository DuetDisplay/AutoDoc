import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { LowSpecMacProcessingBanner } from './LowSpecMacProcessingBanner'

let listeners: Map<string, (payload?: unknown) => void>
let recordings: unknown[]
let dismissed: boolean
let profile: Record<string, string>
let invoke: ReturnType<typeof vi.fn>
beforeEach(() => {
  listeners = new Map()
  recordings = [{ meetingId: 'one' }]
  dismissed = false
  profile = { windowsProcessingProfileId: 'win-low-spec' }
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'recording:list') return recordings
    if (channel === 'whisper:get-setup-status') return profile
    if (channel === 'prefs:get-low-spec-mac-processing-banner-dismissed') return dismissed
    if (channel === 'prefs:set-low-spec-mac-processing-banner-dismissed') dismissed = true
  })
  window.electronAPI = {
    invoke,
    on: vi.fn((channel, listener) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    }),
    send: vi.fn()
  } as any
})
async function mount() {
  await act(async () => {
    render(<LowSpecMacProcessingBanner />)
  })
}
async function emit(channel: string, value?: unknown) {
  await act(async () => {
    listeners.get(channel)?.(value)
  })
}
const banner = () => screen.queryByText('Optimized local processing is on')

it.each(['windowsProcessingProfileId', 'macProcessingProfileId'])(
  'uses %s updates without scanning recordings; presence and dismissal still update',
  async (key) => {
    const low = key.startsWith('windows') ? 'win-low-spec' : 'mac-low-spec'
    profile = { [key]: low }
    await mount()
    expect(banner()).toBeInTheDocument()
    await act(async () => {
      for (let n = 0; n < 5000; n++)
        listeners.get('whisper:setup-progress')?.({ ...profile, percent: 12 })
    })
    expect(invoke.mock.calls.filter(([c]) => c === 'recording:list')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([c]) => c === 'whisper:get-setup-status')).toHaveLength(1)
    await emit('whisper:setup-progress', { [key]: 'normal', percent: 12 })
    expect(banner()).not.toBeInTheDocument()
    await emit('whisper:setup-progress', { [key]: low, percent: 12 })
    expect(banner()).toBeInTheDocument()
    recordings = []
    await emit('recording:entry-updated', { meetingId: 'one' })
    expect(banner()).not.toBeInTheDocument()
    recordings = [{ meetingId: 'two' }]
    await emit('recording:status-changed')
    expect(banner()).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    })
    expect(invoke).toHaveBeenCalledWith('prefs:set-low-spec-mac-processing-banner-dismissed', true)
    await emit('whisper:setup-progress', { [key]: low })
    expect(banner()).not.toBeInTheDocument()
  }
)
it('restores visibility when dismissal persistence fails', async () => {
  await mount()
  invoke.mockRejectedValueOnce(new Error('disk error'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
  })
  expect(banner()).toBeInTheDocument()
})
it('coalesces recording events and discards an obsolete in-flight list response', async () => {
  await mount()
  let release!: (value: unknown[]) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  await emit('recording:entry-updated')
  recordings = []
  await act(async () => {
    for (let n = 0; n < 100; n++) listeners.get('recording:entry-updated')?.()
    release([{ meetingId: 'deleted' }])
  })
  expect(banner()).not.toBeInTheDocument()
  expect(invoke.mock.calls.filter(([c]) => c === 'recording:list')).toHaveLength(3)
})
it('does not let a slow initial setup status overwrite a newer progress event', async () => {
  let release!: (value: unknown) => void
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel: string) =>
    channel === 'whisper:get-setup-status'
      ? new Promise((resolve) => {
          release = resolve
        })
      : original(channel)
  )
  await mount()
  await emit('whisper:setup-progress', { windowsProcessingProfileId: 'win-gpu' })
  await act(async () => {
    release({ windowsProcessingProfileId: 'win-low-spec' })
  })
  expect(banner()).not.toBeInTheDocument()
})
