import { useState, useCallback, useEffect } from 'react'
import { StepDots } from '../components/onboarding/StepDots'
import { WelcomeStep } from '../components/onboarding/WelcomeStep'
import { FeatureStep } from '../components/onboarding/FeatureStep'
import { MicPermissionStep } from '../components/onboarding/MicPermissionStep'
import { ScreenPermissionStep } from '../components/onboarding/ScreenPermissionStep'
import { CalendarStep } from '../components/onboarding/CalendarStep'
import { TranscriptionStep } from '../components/onboarding/TranscriptionStep'
import { OllamaStep } from '../components/onboarding/OllamaStep'
import { AnalyticsStep } from '../components/onboarding/AnalyticsStep'
import { AllSetStep } from '../components/onboarding/AllSetStep'
import { setAnalyticsConsent, trackEvent } from '../services/analytics'
import { recordDiagnosticAction } from '../services/diagnostic-trail'

const DARWIN_STEP_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
const WINDOWS_STEP_ORDER = [0, 1, 2, 3, 6, 7, 8, 9, 10] as const
type NavigationMode = 'restore' | 'forward' | 'back'

function getVisibleStepOrder(platform: string | null): readonly number[] {
  return platform === 'win32' ? WINDOWS_STEP_ORDER : DARWIN_STEP_ORDER
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [platform, setPlatform] = useState<string | null>(null)
  const [stepIndex, setStepIndex] = useState<number | null>(null)
  const [navigationMode, setNavigationMode] = useState<NavigationMode>('restore')
  const [diagnosticLogUploadDraft, setDiagnosticLogUploadDraft] = useState(false)
  const stepOrder = getVisibleStepOrder(platform)
  const step = stepIndex === null ? null : (stepOrder[stepIndex] ?? stepOrder[0])
  const totalDots = Math.max(0, stepOrder.length - 1)

  useEffect(() => {
    Promise.all([
      window.electronAPI.invoke('prefs:get-onboarding-step'),
      window.electronAPI.invoke('app:get-runtime-info')
    ]).then(([saved, runtimeInfo]) => {
      const resolvedPlatform = runtimeInfo?.platform ?? 'darwin'
      const visibleSteps = getVisibleStepOrder(resolvedPlatform)
      const savedStep = saved ?? 0
      const exactIndex = visibleSteps.indexOf(savedStep)

      setPlatform(resolvedPlatform)

      if (exactIndex !== -1) {
        setStepIndex(exactIndex)
        return
      }

      const migratedIndex = visibleSteps.findIndex((candidate) => candidate > savedStep)
      const nextIndex = migratedIndex === -1 ? visibleSteps.length - 1 : migratedIndex
      const normalizedStep = visibleSteps[nextIndex] ?? visibleSteps[0]
      setStepIndex(nextIndex)
      void window.electronAPI.invoke('prefs:set-onboarding-step', normalizedStep)
    })
  }, [])

  const next = useCallback(() => {
    setNavigationMode('forward')
    setStepIndex((currentIndex) => {
      const current = currentIndex ?? 0
      recordDiagnosticAction({
        category: 'onboarding',
        action: 'onboarding_step_completed',
        details: { step: stepOrder[current] ?? stepOrder[0] }
      })
      trackEvent('onboarding_step_completed', { step: stepOrder[current] ?? stepOrder[0] })
      const nextIndex = Math.min(current + 1, stepOrder.length - 1)
      const nextStep = stepOrder[nextIndex] ?? stepOrder[stepOrder.length - 1]
      window.electronAPI.invoke('prefs:set-onboarding-step', nextStep)
      return nextIndex
    })
  }, [stepOrder])

  const back = useCallback(() => {
    setNavigationMode('back')
    setStepIndex((currentIndex) => {
      const current = currentIndex ?? 0
      const previousIndex = Math.max(0, current - 1)
      const previousStep = stepOrder[previousIndex] ?? stepOrder[0]
      void window.electronAPI.invoke('prefs:set-onboarding-step', previousStep)
      return previousIndex
    })
  }, [stepOrder])

  const handleAnalyticsChoice = async (
    consented: boolean,
    diagnosticLogUploadConsented: boolean
  ) => {
    recordDiagnosticAction({
      category: 'onboarding',
      action: 'analytics_choice_made',
      details: {
        consented,
        diagnosticLogUploadConsented: consented ? diagnosticLogUploadConsented : false
      }
    })
    await window.electronAPI.invoke('prefs:set-analytics-consent', consented)
    await window.electronAPI.invoke(
      'prefs:set-diagnostic-log-upload-consent',
      consented ? diagnosticLogUploadConsented : false
    )
    setAnalyticsConsent(consented)
    setNavigationMode('forward')
    setStepIndex((currentIndex) => {
      const nextIndex = Math.min((currentIndex ?? 0) + 1, stepOrder.length - 1)
      const nextStep = stepOrder[nextIndex] ?? stepOrder[stepOrder.length - 1]
      window.electronAPI.invoke('prefs:set-onboarding-step', nextStep)
      return nextIndex
    })
  }

  const handleFinish = async () => {
    trackEvent('onboarding_completed')
    await window.electronAPI.invoke('prefs:set-onboarding-complete')
    onComplete()
  }

  const renderStep = () => {
    switch (step) {
      case 0:
        return <WelcomeStep onNext={next} />
      case 1:
        return (
          <FeatureStep
            icon="🔒"
            iconBg="bg-sage-light"
            heading="Private by Design"
            body="AutoDoc is fully open source and runs entirely on your machine. Your meetings are encrypted on disk and never leave your computer. No cloud. No accounts. No compromises. Built by ex-Apple engineers who believe your data is yours."
            onNext={next}
          />
        )
      case 2:
        return (
          <FeatureStep
            icon="🎧"
            iconBg="bg-dusk-light"
            heading="How It Works"
            body="AutoDoc quietly records your meeting audio, transcribes it locally, and identifies who's speaking — all on your device."
            features={[
              {
                icon: '🎤',
                iconBg: 'bg-sage-light',
                title: 'Captures audio',
                description:
                  'Records mic and system audio separately for clean speaker identification'
              },
              {
                icon: '📝',
                iconBg: 'bg-dusk-light',
                title: 'Transcribes locally',
                description: 'AutoDoc installs a one-time speech engine, then transcribes on-device'
              },
              {
                icon: '👥',
                iconBg: 'bg-mist-light',
                title: 'Identifies speakers',
                description: 'Knows who\'s talking — labels "Me" vs "Them" automatically'
              }
            ]}
            onNext={next}
          />
        )
      case 3:
        return (
          <FeatureStep
            icon="📋"
            iconBg="bg-clay-light"
            heading="Notes That Think"
            body="Inspired by Andy Grove's High Output Management, AutoDoc breaks every meeting into the patterns that matter — fully editable by you."
            features={[
              {
                icon: '✅',
                iconBg: 'bg-[#FEF3C7]',
                title: 'Decisions',
                description: 'What was decided and why'
              },
              {
                icon: '📌',
                iconBg: 'bg-clay-light',
                title: 'Action Items',
                description: 'Who does what, by when'
              },
              {
                icon: '💬',
                iconBg: 'bg-sage-light',
                title: 'Discussion & Status',
                description: 'Key points, updates, and context'
              }
            ]}
            onNext={next}
          />
        )
      case 4:
        return <MicPermissionStep onNext={next} allowAutoAdvance={navigationMode === 'forward'} />
      case 5:
        return (
          <ScreenPermissionStep onNext={next} allowAutoAdvance={navigationMode === 'forward'} />
        )
      case 6:
        return <CalendarStep onNext={next} />
      case 7:
        return <TranscriptionStep onNext={next} />
      case 8:
        return <OllamaStep onNext={next} />
      case 9:
        return (
          <AnalyticsStep
            diagnosticLogUploadConsented={diagnosticLogUploadDraft}
            onDiagnosticLogUploadConsentedChange={setDiagnosticLogUploadDraft}
            onNext={handleAnalyticsChoice}
          />
        )
      case 10:
        return <AllSetStep onFinish={handleFinish} />
      default:
        return null
    }
  }

  if (step === null) return null

  return (
    <div className="h-screen bg-bg-primary relative overflow-y-auto">
      {/* macOS drag region */}
      <div
        className="fixed top-0 left-24 right-24 h-5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      {/* Step dots (hidden on All Set screen) */}
      {stepIndex !== null && stepIndex < totalDots && (
        <div className="fixed top-7 left-1/2 -translate-x-1/2">
          <StepDots total={totalDots} current={stepIndex} />
        </div>
      )}

      {stepIndex !== null && stepIndex > 0 && (
        <button
          type="button"
          onClick={back}
          className="fixed top-12 left-6 px-3 py-2 rounded-[10px] text-[13px] font-medium text-ink-muted hover:text-ink transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          ← Back
        </button>
      )}

      {/* Content */}
      <div className="min-h-full flex flex-col items-center justify-start [@media(min-height:520px)]:justify-center pt-20 pb-8">
        <div className="max-w-[440px] w-full px-6 animate-[fadeUp_400ms_ease]" key={step}>
          {renderStep()}
        </div>
      </div>
    </div>
  )
}
