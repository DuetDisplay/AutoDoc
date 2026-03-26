import { useState, useCallback } from 'react'
import { StepDots } from '../components/onboarding/StepDots'
import { WelcomeStep } from '../components/onboarding/WelcomeStep'
import { FeatureStep } from '../components/onboarding/FeatureStep'
import { MicPermissionStep } from '../components/onboarding/MicPermissionStep'
import { ScreenPermissionStep } from '../components/onboarding/ScreenPermissionStep'
import { CalendarStep } from '../components/onboarding/CalendarStep'
import { TranscriptionStep } from '../components/onboarding/TranscriptionStep'
import { OllamaStep } from '../components/onboarding/OllamaStep'
import { AllSetStep } from '../components/onboarding/AllSetStep'

const TOTAL_DOTS = 9

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0)

  const next = useCallback(() => setStep((s) => s + 1), [])

  const handleFinish = async () => {
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
              { icon: '🎤', iconBg: 'bg-sage-light', title: 'Captures audio', description: 'Records mic and system audio separately for clean speaker identification' },
              { icon: '📝', iconBg: 'bg-dusk-light', title: 'Transcribes locally', description: 'whisper.cpp runs on-device — fast, private, no internet needed' },
              { icon: '👥', iconBg: 'bg-mist-light', title: 'Identifies speakers', description: "Knows who's talking — labels \"Me\" vs \"Them\" automatically" },
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
              { icon: '✅', iconBg: 'bg-[#FEF3C7]', title: 'Decisions', description: 'What was decided and why' },
              { icon: '📌', iconBg: 'bg-clay-light', title: 'Action Items', description: 'Who does what, by when' },
              { icon: '💬', iconBg: 'bg-sage-light', title: 'Discussion & Status', description: 'Key points, updates, and context' },
            ]}
            onNext={next}
          />
        )
      case 4:
        return <MicPermissionStep onNext={next} />
      case 5:
        return <ScreenPermissionStep onNext={next} />
      case 6:
        return <CalendarStep onNext={next} />
      case 7:
        return <TranscriptionStep onNext={next} />
      case 8:
        return <OllamaStep onNext={next} />
      case 9:
        return <AllSetStep onFinish={handleFinish} />
      default:
        return null
    }
  }

  return (
    <div className="h-screen bg-bg-primary flex flex-col items-center justify-center relative">
      {/* macOS drag region */}
      <div
        className="absolute top-0 left-0 right-0 h-[52px]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      {/* Step dots (hidden on All Set screen) */}
      {step < TOTAL_DOTS && (
        <div className="absolute top-7 left-1/2 -translate-x-1/2">
          <StepDots total={TOTAL_DOTS} current={step} />
        </div>
      )}

      {/* Content */}
      <div className="max-w-[440px] w-full px-6 animate-[fadeUp_400ms_ease]" key={step}>
        {renderStep()}
      </div>
    </div>
  )
}
