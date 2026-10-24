import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { translate, type MessageKey } from '../../../shared/i18n'
import type { UiLanguageCode } from '../../../shared/ui-language'
import { MediaPlaybackControls } from './MediaPlaybackControls'

const ui = vi.hoisted(() => ({ language: 'en' }))
vi.mock('../services/i18n', () => ({
  useI18n: () => ({
    language: ui.language,
    t: (key: MessageKey, params?: Record<string, string | number>) =>
      translate(ui.language as UiLanguageCode, key, params)
  })
}))

function fixture() {
  const media = document.createElement('audio')
  let paused = true
  Object.defineProperty(media, 'duration', { configurable: true, value: 120 })
  Object.defineProperty(media, 'paused', { configurable: true, get: () => paused })
  media.play = vi.fn(async () => {
    paused = false
    media.dispatchEvent(new Event('play'))
  })
  media.pause = vi.fn(() => {
    paused = true
    media.dispatchEvent(new Event('pause'))
  })
  const mediaRef = { current: media }
  return { media, mediaRef }
}

describe('localized media playback controls', () => {
  beforeEach(() => {
    ui.language = 'en'
  })

  it('controls real media properties and follows playback, seeking and volume events', async () => {
    const { media, mediaRef } = fixture()
    render(
      <MediaPlaybackControls
        mediaRef={mediaRef}
        sourceKey="synthetic"
        playbackRate={1}
        onCyclePlaybackRate={() => {}}
      />
    )
    const seek = screen.getByRole('slider', { name: 'Seek' })
    await waitFor(() => expect(seek).toHaveAttribute('max', '120'))
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(await screen.findByRole('button', { name: 'Play' })).toBeEnabled()
    fireEvent.change(seek, { target: { value: '30' } })
    expect(media.currentTime).toBe(30)
    expect((seek as HTMLInputElement).value).toBe('30')
    fireEvent.timeUpdate(media)
    await waitFor(() => expect(seek).toHaveAttribute('aria-valuetext', '0:30 / 2:00'))
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '25' } })
    expect(media.volume).toBe(0.25)
    expect((screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement).value).toBe('25')
    fireEvent.volumeChange(media)
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
    expect(media.muted).toBe(true)
    fireEvent.volumeChange(media)
    fireEvent.click(await screen.findByRole('button', { name: 'Unmute' }))
    expect(media.muted).toBe(false)
    expect(media.volume).toBe(0.25)
  })

  it('updates labels and decimal speed when the app language changes', async () => {
    const { mediaRef } = fixture()
    const onCyclePlaybackRate = vi.fn()
    const props = { mediaRef, sourceKey: 'synthetic', playbackRate: 1.25, onCyclePlaybackRate }
    const { rerender } = render(<MediaPlaybackControls {...props} />)
    ui.language = 'de'
    rerender(<MediaPlaybackControls {...props} />)
    expect(screen.getByRole('button', { name: 'Abspielen' })).toBeInTheDocument()
    const rate = screen.getByRole('button', { name: 'Wiedergabegeschwindigkeit: 1,25×' })
    expect(rate).toHaveTextContent('1,25×')
    expect(mediaRef.current.playbackRate).toBe(1.25)
    fireEvent.click(rate)
    expect(onCyclePlaybackRate).toHaveBeenCalledOnce()
    ui.language = 'ja'
    rerender(<MediaPlaybackControls {...props} />)
    expect(screen.getByRole('button', { name: '再生' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: '音量' })).toBeInTheDocument()
    await act(async () => {})
  })

  it('shows a translated error instead of an exception when playback fails', async () => {
    const { media, mediaRef } = fixture()
    media.play = vi.fn().mockRejectedValue(new Error('private decoder details'))
    render(
      <MediaPlaybackControls
        mediaRef={mediaRef}
        sourceKey="synthetic"
        playbackRate={1}
        onCyclePlaybackRate={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(translate('en', 'media.unavailable'))
    expect(screen.queryByText(/private decoder/)).not.toBeInTheDocument()
  })

  it('reports unavailable fullscreen and keeps the recording playable', async () => {
    const { mediaRef } = fixture()
    const target = document.createElement('div')
    target.requestFullscreen = vi.fn().mockRejectedValue(new Error('fullscreen not allowed'))
    const fullscreenTarget = createRef<HTMLDivElement>()
    fullscreenTarget.current = target
    render(
      <MediaPlaybackControls
        mediaRef={mediaRef}
        sourceKey="synthetic"
        playbackRate={1}
        onCyclePlaybackRate={() => {}}
        fullscreenTarget={fullscreenTarget}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      translate('en', 'media.fullscreenFailed')
    )
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled()
  })
  it('clears a prior playback failure when another recording is loaded', async () => {
    const { media, mediaRef } = fixture()
    media.play = vi.fn().mockRejectedValue(new Error('unavailable old source'))
    const props = { mediaRef, playbackRate: 1, onCyclePlaybackRate: () => {} }
    const { rerender } = render(<MediaPlaybackControls {...props} sourceKey="old" />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    await screen.findByRole('alert')
    rerender(<MediaPlaybackControls {...props} sourceKey="new" />)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
  it('does not report an intentionally cancelled play request as a playback failure', async () => {
    const { media, mediaRef } = fixture()
    let rejectPlay: (reason: unknown) => void = () => {}
    media.play = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject
        })
    )
    render(
      <MediaPlaybackControls
        mediaRef={mediaRef}
        sourceKey="synthetic"
        playbackRate={1}
        onCyclePlaybackRate={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    await act(async () => {
      media.pause()
      rejectPlay(new DOMException('Interrupted by pause', 'AbortError'))
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('preserves picture-in-picture and follows its native enter and leave events', async () => {
    const video = document.createElement('video')
    const originalEnabled = Object.getOwnPropertyDescriptor(document, 'pictureInPictureEnabled')
    const originalElement = Object.getOwnPropertyDescriptor(document, 'pictureInPictureElement')
    const originalExit = Object.getOwnPropertyDescriptor(document, 'exitPictureInPicture')
    let active: HTMLVideoElement | null = null
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
    Object.defineProperty(document, 'pictureInPictureElement', {
      configurable: true,
      get: () => active
    })
    video.requestPictureInPicture = vi.fn(async () => {
      active = video
      video.dispatchEvent(new Event('enterpictureinpicture'))
      return {} as PictureInPictureWindow
    })
    const exit = vi.fn(async () => {
      active = null
      video.dispatchEvent(new Event('leavepictureinpicture'))
    })
    Object.defineProperty(document, 'exitPictureInPicture', { configurable: true, value: exit })
    try {
      const fullscreenTarget = { current: document.createElement('div') }
      render(
        <MediaPlaybackControls
          mediaRef={{ current: video }}
          sourceKey="synthetic"
          playbackRate={1}
          onCyclePlaybackRate={() => {}}
          fullscreenTarget={fullscreenTarget}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Exit picture-in-picture' }))
      await screen.findByRole('button', { name: 'Picture-in-picture' })
      expect(video.requestPictureInPicture).toHaveBeenCalledOnce()
      expect(exit).toHaveBeenCalledOnce()
    } finally {
      for (const [name, descriptor] of [
        ['pictureInPictureEnabled', originalEnabled],
        ['pictureInPictureElement', originalElement],
        ['exitPictureInPicture', originalExit]
      ] as const) {
        if (descriptor) Object.defineProperty(document, name, descriptor)
        else Reflect.deleteProperty(document, name)
      }
    }
  })
  it('uses the current fullscreen document state when a click precedes its change event', async () => {
    const { mediaRef } = fixture()
    const target = document.createElement('div')
    const request = vi.fn()
    target.requestFullscreen = request
    const originalElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
    const originalExit = Object.getOwnPropertyDescriptor(document, 'exitFullscreen')
    let active: Element | null = target
    const exit = vi.fn(async () => {
      active = null
    })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => active })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
    try {
      render(
        <MediaPlaybackControls
          mediaRef={mediaRef}
          sourceKey="synthetic"
          playbackRate={1}
          onCyclePlaybackRate={() => {}}
          fullscreenTarget={{ current: target }}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
      await act(async () => {})
      expect(exit).toHaveBeenCalledOnce()
      expect(request).not.toHaveBeenCalled()
    } finally {
      for (const [name, descriptor] of [
        ['fullscreenElement', originalElement],
        ['exitFullscreen', originalExit]
      ] as const) {
        if (descriptor) Object.defineProperty(document, name, descriptor)
        else Reflect.deleteProperty(document, name)
      }
    }
  })
})
