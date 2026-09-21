import { describe, expect, it } from 'vitest'
import { memoryFailureFromError, memoryFailureDetails } from '../memory-failure'

describe('memory failure evidence', () => {
  it('uses the Windows rejection floor, not the preferred memory target', () => {
    const failure = memoryFailureFromError(
      'Insufficient free memory for GPU transcription pass (1.9 GiB free, floor 2.5 GiB) after extended wait'
    )!
    expect(failure).toEqual({
      available: { value: 1.9, unit: 'GiB' },
      minimum: { value: 2.5, unit: 'GiB' }
    })
    expect(memoryFailureDetails(failure)).toBe(
      'Available when checked: 1.9 GiB · Minimum to start: 2.5 GiB'
    )
  })

  it('keeps the units and values actually reported by Ollama on either platform', () => {
    const failure = memoryFailureFromError(
      'Ollama returned 500: {"error":"model requires more system memory (3.4 GiB) than is available (800 MiB)"}'
    )!
    expect(memoryFailureDetails(failure)).toBe(
      'Available when checked: 800 MiB · Minimum to start: 3.4 GiB'
    )
  })

  it.each([
    'parakeet worker failed: MemoryError',
    'whisper.cpp exited with code 1: std::bad_alloc',
    'mlx whisper failed: Metal out of memory',
    'MPS backend out of memory',
    'DefaultCPUAllocator: not enough memory to allocate'
  ])('recognizes explicit memory exhaustion without fabricating a threshold: %s', (raw) => {
    expect(memoryFailureFromError(raw)).toEqual({})
    expect(memoryFailureDetails(memoryFailureFromError(raw)!)).toBeUndefined()
  })

  it.each([
    'whisper.cpp exited with code null (signal SIGABRT): ggml_metal_rsets_free',
    'parakeet worker failed: DirectML device removed',
    'CUDA out of memory: MemoryError',
    'model runner has unexpectedly stopped, this may be due to resource limitations or an internal error',
    'ENOSPC: no space left on device',
    'model not found',
    'request timed out'
  ])('does not infer a system RAM shortage from unrelated errors: %s', (raw) => {
    expect(memoryFailureFromError(raw)).toBeUndefined()
  })

  it('omits missing or invalid amounts', () => {
    expect(memoryFailureDetails({})).toBeUndefined()
    expect(memoryFailureDetails({ available: { value: 1.9, unit: 'GB' } })).toBeUndefined()
    expect(
      memoryFailureDetails({
        available: { value: NaN, unit: 'GB' },
        minimum: { value: 0, unit: 'GB' }
      })
    ).toBeUndefined()
  })
})
