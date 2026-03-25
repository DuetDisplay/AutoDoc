import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ROUTES } from '../../../shared/constants'

interface DetectionPayload {
  title: string
  body: string
}

export function MeetingDetectedBanner() {
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
    <div className="mx-4 mt-2 px-4 py-3 bg-sage-light border border-sage/20 rounded-xl flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-2.5 h-2.5 rounded-full bg-sage animate-pulse shrink-0" />
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-sage-dark truncate">
            {detection.title}
          </p>
          <p className="text-[11px] text-sage-dark/70">
            {detection.body}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={handleDismiss}
          className="px-3 py-1.5 text-[11px] font-medium text-sage-dark/70 hover:text-sage-dark transition-colors"
        >
          Dismiss
        </button>
        <button
          onClick={handleRecord}
          className="px-3 py-1.5 text-[11px] font-semibold bg-sage text-white rounded-lg hover:opacity-90 transition-opacity"
        >
          Record
        </button>
      </div>
    </div>
  )
}
