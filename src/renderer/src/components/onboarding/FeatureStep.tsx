interface FeatureRow {
  icon: string
  iconBg: string
  title: string
  description: string
}

interface FeatureStepProps {
  icon: string
  iconBg: string
  heading: string
  body: string
  features?: FeatureRow[]
  onNext: () => void
}

export function FeatureStep({ icon, iconBg, heading, body, features, onNext }: FeatureStepProps) {
  return (
    <div className="text-center">
      <div className={`w-16 h-16 rounded-2xl ${iconBg} flex items-center justify-center text-[28px] mx-auto mb-5`}>
        {icon}
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">{heading}</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">{body}</p>

      {features && (
        <div className="flex flex-col gap-3 mb-7 text-left">
          {features.map((f) => (
            <div key={f.title} className="flex items-start gap-3 px-4 py-3 bg-bg-card border border-border rounded-xl">
              <div className={`w-9 h-9 rounded-lg ${f.iconBg} flex items-center justify-center text-[16px] shrink-0`}>
                {f.icon}
              </div>
              <div>
                <div className="text-[13px] font-semibold text-ink">{f.title}</div>
                <div className="text-[12px] text-ink-muted leading-snug mt-0.5">{f.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={onNext}
        className="px-8 py-3 border border-border rounded-[10px] text-[14px] font-medium text-ink hover:border-border-strong transition-colors"
      >
        Next →
      </button>
    </div>
  )
}
