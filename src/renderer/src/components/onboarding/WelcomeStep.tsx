export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center">
      {/* Animated waveform */}
      <div className="flex items-center justify-center gap-[3px] h-10 mb-6">
        {[0, 0.1, 0.2, 0.3, 0.15, 0.25, 0.05].map((delay, i) => (
          <div
            key={i}
            className="w-[3px] rounded-sm bg-sage"
            style={{
              height: [12, 24, 36, 20, 32, 16, 28][i],
              transformOrigin: 'bottom',
              animation: `wave 1.2s ease-in-out ${delay}s infinite`,
            }}
          />
        ))}
      </div>

      <h1 className="font-serif text-[36px] text-ink tracking-[-0.02em]">AutoDoc</h1>
      <p className="text-[15px] text-ink-muted leading-relaxed mt-1.5 mb-8">
        Your meetings talk. We listen.
        <br />
        So you don't have to take notes.
      </p>
      <button
        onClick={onNext}
        className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
      >
        Get Started →
      </button>
    </div>
  )
}
