import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useI18n } from '../services/i18n'
import { dateLocaleForUiLanguage } from '../../../shared/ui-language'

interface MediaPlaybackControlsProps {
  mediaRef: RefObject<HTMLMediaElement | null>
  sourceKey: string
  playbackRate: number
  onCyclePlaybackRate: () => void
  fullscreenTarget?: RefObject<HTMLDivElement | null>
}

interface MediaState {
  paused: boolean
  currentTime: number
  duration: number
  muted: boolean
  volume: number
  failed: boolean
  pictureInPicture: boolean
}

const buttonClass =
  'flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-ink hover:bg-bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage disabled:cursor-not-allowed disabled:text-ink-muted'

function ControlIcon({
  kind
}: {
  kind: 'play' | 'pause' | 'mute' | 'volume' | 'expand' | 'collapse' | 'download' | 'pip'
}) {
  const paths = {
    play: 'M6 3.5 16 10 6 16.5Z',
    pause: 'M6 4v12M14 4v12',
    volume: 'M3 7h3l4-4v14l-4-4H3ZM13 6a6 6 0 0 1 0 8M15 3a10 10 0 0 1 0 14',
    mute: 'M3 7h3l4-4v14l-4-4H3ZM13 7l5 6M18 7l-5 6',
    expand: 'M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4',
    collapse: 'M7 3v4H3M17 7h-4V3M13 17v-4h4M3 13h4v4',
    download: 'M10 2v10m-4-4 4 4 4-4M3 14v3h14v-3',
    pip: 'M2 3h16v14H2ZM10 10h6v5h-6Z'
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill={kind === 'play' ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={kind === 'pause' ? 3 : 1.6}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d={paths[kind]} />
    </svg>
  )
}

/** App-owned controls keep media actions in the selected UI language. */
export function MediaPlaybackControls({
  mediaRef,
  sourceKey,
  playbackRate,
  onCyclePlaybackRate,
  fullscreenTarget
}: MediaPlaybackControlsProps) {
  const { language, t } = useI18n()
  const [state, setState] = useState<MediaState>({
    paused: true,
    currentTime: 0,
    duration: 0,
    muted: false,
    volume: 1,
    failed: false,
    pictureInPicture: false
  })
  const [playError, setPlayError] = useState(false)
  const [pipError, setPipError] = useState(false)
  const [fullscreenError, setFullscreenError] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenButton = useRef<HTMLButtonElement>(null)
  const number = useMemo(
    () => new Intl.NumberFormat(dateLocaleForUiLanguage(language), { useGrouping: false }),
    [language]
  )
  const padded = useMemo(
    () =>
      new Intl.NumberFormat(dateLocaleForUiLanguage(language), {
        useGrouping: false,
        minimumIntegerDigits: 2
      }),
    [language]
  )
  const percent = useMemo(
    () =>
      new Intl.NumberFormat(dateLocaleForUiLanguage(language), {
        style: 'percent',
        maximumFractionDigits: 0
      }),
    [language]
  )

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    let active = true
    const sync = () => {
      if (!active) return
      setState({
        paused: media.paused,
        currentTime: media.currentTime,
        duration: media.duration,
        muted: media.muted,
        volume: media.volume,
        failed: Boolean(media.error),
        pictureInPicture: document.pictureInPictureElement === media
      })
    }
    const events = [
      'loadedmetadata',
      'durationchange',
      'timeupdate',
      'seeked',
      'play',
      'pause',
      'ended',
      'volumechange',
      'error',
      'enterpictureinpicture',
      'leavepictureinpicture'
    ]
    for (const event of events) media.addEventListener(event, sync)
    // Metadata can already be cached when the controls mount.
    queueMicrotask(() => {
      if (!active) return
      setPlayError(false)
      setFullscreenError(false)
      setPipError(false)
      sync()
    })
    return () => {
      active = false
      for (const event of events) media.removeEventListener(event, sync)
    }
  }, [mediaRef, sourceKey])

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    const applyRate = () => {
      media.defaultPlaybackRate = playbackRate
      media.playbackRate = playbackRate
    }
    applyRate()
    media.addEventListener('loadedmetadata', applyRate)
    return () => media.removeEventListener('loadedmetadata', applyRate)
  }, [mediaRef, sourceKey, playbackRate])

  useEffect(() => {
    let active = true
    let wasFullscreen = false
    const sync = () => {
      if (!active) return
      const next = Boolean(
        fullscreenTarget?.current && document.fullscreenElement === fullscreenTarget.current
      )
      if (wasFullscreen && !next) fullscreenButton.current?.focus({ preventScroll: true })
      wasFullscreen = next
      setFullscreen(next)
    }
    document.addEventListener('fullscreenchange', sync)
    queueMicrotask(sync)
    return () => {
      active = false
      document.removeEventListener('fullscreenchange', sync)
    }
  }, [fullscreenTarget])

  const time = (value: number) => {
    if (!Number.isFinite(value) || value < 0) return '--:--'
    const seconds = Math.floor(value),
      hours = Math.floor(seconds / 3600),
      minutes = Math.floor(seconds / 60) % 60
    return hours
      ? `${number.format(hours)}:${padded.format(minutes)}:${padded.format(seconds % 60)}`
      : `${number.format(minutes)}:${padded.format(seconds % 60)}`
  }
  const hasDuration = Number.isFinite(state.duration) && state.duration > 0
  const muted = state.muted || state.volume === 0
  const rate = `${number.format(playbackRate)}×`
  const playLabel = state.paused ? t('media.play') : t('media.pause')
  const muteLabel = muted ? t('media.unmute') : t('media.mute')
  const fullscreenLabel = fullscreen ? t('media.exitFullscreen') : t('media.enterFullscreen')

  const togglePlay = async () => {
    const media = mediaRef.current
    if (!media) return
    setPlayError(false)
    try {
      if (media.paused) await media.play()
      else media.pause()
    } catch (error) {
      // Pausing or changing the source can intentionally cancel a pending play request.
      if (error instanceof DOMException && error.name === 'AbortError' && media.paused) return
      setPlayError(true)
    }
  }
  const togglePictureInPicture = async () => {
    const media = mediaRef.current
    if (!(media instanceof HTMLVideoElement)) return
    setPipError(false)
    try {
      if (document.pictureInPictureElement === media) await document.exitPictureInPicture()
      else await media.requestPictureInPicture()
    } catch {
      setPipError(true)
    }
  }
  const toggleFullscreen = async () => {
    setFullscreenError(false)
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else {
        if (document.pictureInPictureElement === mediaRef.current)
          await document.exitPictureInPicture()
        await fullscreenTarget?.current?.requestFullscreen()
      }
    } catch {
      setFullscreenError(true)
    }
  }

  return (
    <div className="border-t border-border bg-bg-card px-3 py-2">
      <div
        role="group"
        aria-label={t('media.controls')}
        className="flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          className={buttonClass}
          title={playLabel}
          aria-label={playLabel}
          disabled={state.failed}
          onClick={() => void togglePlay()}
        >
          <ControlIcon kind={state.paused ? 'play' : 'pause'} />
        </button>
        <span className="shrink-0 font-mono text-[11px] text-ink-muted">
          {time(state.currentTime)} / {time(state.duration)}
        </span>
        <input
          type="range"
          min={0}
          max={hasDuration ? state.duration : 0}
          step={0.1}
          value={hasDuration ? Math.min(state.currentTime, state.duration) : 0}
          disabled={!hasDuration || state.failed}
          aria-label={t('media.seek')}
          aria-valuetext={`${time(state.currentTime)} / ${time(state.duration)}`}
          className="media-range min-w-24 flex-1 basis-28"
          onChange={(event) => {
            const media = mediaRef.current
            if (media && hasDuration) {
              const next = Number(event.target.value)
              media.currentTime = next
              setState((previous) => ({ ...previous, currentTime: next }))
            }
          }}
        />
        <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass}
            title={muteLabel}
            aria-label={muteLabel}
            onClick={() => {
              const media = mediaRef.current
              if (!media) return
              if (muted) {
                if (media.volume === 0) media.volume = 1
                media.muted = false
              } else media.muted = true
              setState((previous) => ({ ...previous, volume: media.volume, muted: media.muted }))
            }}
          >
            <ControlIcon kind={muted ? 'mute' : 'volume'} />
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={muted ? 0 : Math.round(state.volume * 100)}
            aria-label={t('media.volume')}
            aria-valuetext={percent.format(muted ? 0 : state.volume)}
            className="media-range w-16 shrink-0"
            onChange={(event) => {
              const media = mediaRef.current
              if (media) {
                media.volume = Number(event.target.value) / 100
                media.muted = media.volume === 0
                setState((previous) => ({ ...previous, volume: media.volume, muted: media.muted }))
              }
            }}
          />
          <button
            type="button"
            className={`${buttonClass} text-[11px] font-semibold`}
            title={t('media.playbackSpeed', { rate })}
            aria-label={t('media.playbackSpeed', { rate })}
            disabled={state.failed}
            onClick={onCyclePlaybackRate}
          >
            {rate}
          </button>
          {!state.failed && (
            <a
              href={`${sourceKey}${sourceKey.includes('?') ? '&' : '?'}download=1`}
              download
              className={buttonClass}
              title={t('media.download')}
              aria-label={t('media.download')}
            >
              <ControlIcon kind="download" />
            </a>
          )}
          {fullscreenTarget && document.pictureInPictureEnabled && (
            <button
              type="button"
              className={buttonClass}
              title={
                state.pictureInPicture
                  ? t('media.exitPictureInPicture')
                  : t('media.pictureInPicture')
              }
              aria-label={
                state.pictureInPicture
                  ? t('media.exitPictureInPicture')
                  : t('media.pictureInPicture')
              }
              disabled={state.failed}
              onClick={() => void togglePictureInPicture()}
            >
              <ControlIcon kind="pip" />
            </button>
          )}
          {fullscreenTarget && (
            <button
              ref={fullscreenButton}
              type="button"
              className={buttonClass}
              title={fullscreenLabel}
              aria-label={fullscreenLabel}
              disabled={state.failed}
              onClick={() => void toggleFullscreen()}
            >
              <ControlIcon kind={fullscreen ? 'collapse' : 'expand'} />
            </button>
          )}
        </div>
      </div>
      {(state.failed || playError) && (
        <p role="alert" className="mt-2 text-[12px] text-clay-dark">
          {t('media.unavailable')}
        </p>
      )}
      {pipError && (
        <p role="alert" className="mt-2 text-[12px] text-clay-dark">
          {t('media.pictureInPictureFailed')}
        </p>
      )}
      {fullscreenError && (
        <p role="alert" className="mt-2 text-[12px] text-clay-dark">
          {t('media.fullscreenFailed')}
        </p>
      )}
    </div>
  )
}
