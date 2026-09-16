export interface MemoryAmount {
  value: number
  unit: 'GB' | 'GiB' | 'MB' | 'MiB'
}

export interface MemoryFailure {
  available?: MemoryAmount
  minimum?: MemoryAmount
}

// Read values from the failed attempt, never from the machine's current RAM.
// Keep the engine's units: GB and GiB are not interchangeable.
export function memoryFailureFromError(raw: string): MemoryFailure | undefined {
  const gate = raw.match(
    /Insufficient free memory for GPU transcription pass \(([\d.]+) GiB free, floor ([\d.]+) GiB\)/i
  )
  const ollama = raw.match(
    /requires more system memory \(([\d.]+) (GiB|GB|MiB|MB)\) than is available \(([\d.]+) (GiB|GB|MiB|MB)\)/i
  )
  const amount = (value: string, unit: string): MemoryAmount | undefined => {
    const n = Number(value)
    const normalizedUnit = ['GB', 'GiB', 'MB', 'MiB'].find(
      (candidate) => candidate.toLowerCase() === unit.toLowerCase()
    ) as MemoryAmount['unit'] | undefined
    return Number.isFinite(n) && n >= 0 && normalizedUnit
      ? { value: n, unit: normalizedUnit }
      : undefined
  }
  if (gate) {
    return { available: amount(gate[1], 'GiB'), minimum: amount(gate[2], 'GiB') }
  }
  if (ollama) {
    return { available: amount(ollama[3], ollama[4]), minimum: amount(ollama[1], ollama[2]) }
  }
  if (
    /insufficient free memory for GPU transcription pass|requires more system memory.*than is available/i.test(
      raw
    )
  )
    return {}

  // Dedicated GPU exhaustion and generic crashes do not establish a RAM shortage.
  if (/CUDA|DirectML|VRAM|device (?:lost|removed)|GPU out of memory/i.test(raw)) return undefined
  if (
    /\bstd::bad_alloc\b|\bMemoryError\b|\b(?:Default)?CPUAllocator\b.*(?:allocate|memory)|\b(?:system|host|Metal|MPS backend) (?:is )?out of memory|\b(?:system|host) memory exhausted/i.test(
      raw
    )
  )
    return {}
  return undefined
}

export function memoryFailureDetails(failure: MemoryFailure): string | undefined {
  const { available, minimum } = failure
  if (
    !available ||
    !minimum ||
    !Number.isFinite(available.value) ||
    available.value < 0 ||
    !Number.isFinite(minimum.value) ||
    minimum.value <= 0
  )
    return undefined
  const format = (amount: MemoryAmount): string =>
    `${amount.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${amount.unit}`
  return `Available when checked: ${format(available)} · Minimum to start: ${format(minimum)}`
}
