import { useT } from '../services/i18n'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ROUTES } from '../../../shared/constants'

interface DetectionPayload {
  title: string
  body: string
}

export function MeetingDetectedBanner() {
  const t = useT()

  const [detection, setDetection] = useState<DetectionPayload | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const unsubDetected = window.electronAPI.on('detection:meeting-detected', (payload) => {
      setDetection(payload)
    })
    const unsubInactive = window.electronAPI.on('detection:mic-inactive', () => {
      setDetection(null)
    })
    return () => {
      unsubDetected()
      unsubInactive()
    }
  }, [])

  if (!detection) return null

  const handleRecord = () => {
    setDetection(null)
    navigate(ROUTES.upcoming)
  }

  const handleDismiss = () => {
    setDetection(null)
    window.electronAPI.invoke('detection:dismiss')
  }

  return (
    <div className="app-banner mx-4 mt-2 px-4 py-3 bg-sage-light border border-sage/20 rounded-xl">
      <div className="app-banner-row">
        <div className="w-2.5 h-2.5 rounded-full bg-sage animate-pulse shrink-0 mt-1" />
        <div className="app-banner-copy">
          <p
            className="text-[12.5px] font-semibold text-sage-dark i18n-ellipsis"
            title={detection.title}
          >
            {detection.title}
          </p>
          <p className="text-[11px] text-sage-dark text-pretty [overflow-wrap:anywhere]">
            {detection.body}
          </p>
        </div>
        <div className="app-banner-actions">
          <button
            onClick={handleDismiss}
            className="px-3 py-1.5 text-[11px] font-medium text-sage-dark hover:text-sage-dark transition-colors"
          >
            {t('common.dismiss')}
          </button>
          <button
            onClick={handleRecord}
            className="i18n-btn px-3 py-1.5 text-[11px] font-semibold bg-sage text-on-brand rounded-lg hover:opacity-90 transition-opacity"
          >
            {t('recording.record')}
          </button>
        </div>
      </div>
    </div>
  )
}
