export function AllSetStep({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="text-center">
      {/* Green check circle */}
      <div className="w-16 h-16 rounded-full bg-sage-light flex items-center justify-center mx-auto mb-5">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4A6B4E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">You're All Set</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        AutoDoc is ready to go. Start or join a meeting and we'll take it from here.
      </p>
      <button
        onClick={onFinish}
        className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
      >
        Open AutoDoc
      </button>
    </div>
  )
}
