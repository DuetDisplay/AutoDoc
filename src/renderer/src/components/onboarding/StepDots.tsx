export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex gap-1.5 justify-center">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          data-testid="step-dot"
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i < current
              ? 'w-1.5 bg-sage'
              : i === current
                ? 'w-4 bg-ink'
                : 'w-1.5 bg-border'
          }`}
        />
      ))}
    </div>
  )
}
