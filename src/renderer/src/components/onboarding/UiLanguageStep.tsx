import { useState } from 'react'
import { useI18n } from '../../services/i18n'
import { UiLanguagePicker } from '../UiLanguagePicker'
import type { UiLanguageCode } from '../../../../shared/ui-language'

export function UiLanguageStep({ onNext }: { onNext: () => void }) {
  const { t, language, setLanguage } = useI18n()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const chooseLanguage = async (next: UiLanguageCode) => {
    setSaving(true)
    setError(false)
    try {
      await setLanguage(next)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <section data-testid="ui-language-step" className="text-center">
      <h2 className="mb-2 text-[24px] font-bold leading-tight tracking-[-0.02em] text-ink">
        {t('onboarding.chooseUiLanguage')}
      </h2>
      <p className="mb-6 text-[14px] leading-relaxed text-ink-muted">
        {t('onboarding.uiLanguageDescription')}
      </p>
      <div className="mb-6 flex justify-center">
        <UiLanguagePicker
          value={language}
          onChange={(next) => void chooseLanguage(next)}
          label={t('uiLanguage.title')}
        />
      </div>
      {error && (
        <p role="alert" className="mb-4 text-[13px] text-clay-dark">
          {t('ui.couldNotSaveThisPreferenceTryAgain')}
        </p>
      )}
      <button
        type="button"
        disabled={saving}
        onClick={onNext}
        className="i18n-btn rounded-[10px] bg-sage px-6 py-2.5 text-[14px] font-semibold text-on-brand hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage disabled:opacity-60"
      >
        {t('ui.continue')}
      </button>
    </section>
  )
}
