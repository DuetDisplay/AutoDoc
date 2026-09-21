import { describe, expect, it, vi } from 'vitest'
import { LocalProcessingCoordinator } from '../local-processing-coordinator'
import { shouldSerializeWindowsLocalProcessing } from '../windows-transcription-runtime'

describe('LocalProcessingCoordinator', () => {
  it('drains concurrent Windows work before admitting CPU recovery and releases after failure', async () => {
    let serialize = false
    const coordinator = new LocalProcessingCoordinator(() => serialize)
    let finishNotes!: () => void
    const notes = coordinator.runWindows(
      () =>
        new Promise<void>((resolve) => {
          finishNotes = resolve
        })
    )
    await vi.waitFor(() => expect(finishNotes).toBeTypeOf('function'))
    serialize = true
    const recovery = vi.fn().mockRejectedValue(new Error('CPU failure'))
    const pending = coordinator.runWindows(recovery).catch((error) => error.message)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(recovery).not.toHaveBeenCalled()
    finishNotes()
    await notes
    expect(await pending).toBe('CPU failure')
    expect(await coordinator.runWindows(async () => 'next')).toBe('next')
  })

  it('preserves healthy Windows concurrency and waits for a serialized pass even if pressure clears', async () => {
    let serialize = false
    const coordinator = new LocalProcessingCoordinator(() => serialize)
    let finishFirst!: () => void
    const first = coordinator.runWindows(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        })
    )
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'))
    expect(await coordinator.runWindows(async () => 'concurrent')).toBe('concurrent')
    finishFirst()
    await first
    serialize = true
    let finishCpu!: () => void
    const cpu = coordinator.runWindows(
      () =>
        new Promise<void>((resolve) => {
          finishCpu = resolve
        })
    )
    await vi.waitFor(() => expect(finishCpu).toBeTypeOf('function'))
    serialize = false
    const next = vi.fn().mockResolvedValue('next')
    const pending = coordinator.runWindows(next)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(next).not.toHaveBeenCalled()
    finishCpu()
    await cpu
    expect(await pending).toBe('next')
  })
  it('serializes local processing when low-spec mode is active', async () => {
    const coordinator = new LocalProcessingCoordinator(() => true)
    const order: string[] = []
    let releaseTranscription!: () => void

    const transcription = coordinator.runExclusive('transcription', 'm1', async () => {
      order.push('transcription-start')
      await new Promise<void>((resolve) => {
        releaseTranscription = resolve
      })
      order.push('transcription-end')
    })

    await vi.waitFor(() => {
      expect(order).toEqual(['transcription-start'])
    })

    const segmentation = coordinator.runExclusive('segmentation', 'm2', async () => {
      order.push('segmentation-start')
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['transcription-start'])

    releaseTranscription()
    await Promise.all([transcription, segmentation])

    expect(order).toEqual(['transcription-start', 'transcription-end', 'segmentation-start'])
  })

  it('does not serialize when normal mode is active', async () => {
    const coordinator = new LocalProcessingCoordinator(() => false)
    const order: string[] = []

    await Promise.all([
      coordinator.runExclusive('transcription', 'm1', async () => {
        order.push('transcription')
      }),
      coordinator.runExclusive('segmentation', 'm2', async () => {
        order.push('segmentation')
      })
    ])

    expect(order.sort()).toEqual(['segmentation', 'transcription'])
  })

  it('supports async runtime pressure checks', async () => {
    const coordinator = new LocalProcessingCoordinator(async () => true)
    const order: string[] = []
    let releaseTranscription!: () => void

    const transcription = coordinator.runExclusive('transcription', 'm1', async () => {
      order.push('transcription-start')
      await new Promise<void>((resolve) => {
        releaseTranscription = resolve
      })
      order.push('transcription-end')
    })

    await vi.waitFor(() => {
      expect(order).toEqual(['transcription-start'])
    })

    const segmentation = coordinator.runExclusive('segmentation', 'm2', async () => {
      order.push('segmentation-start')
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['transcription-start'])

    releaseTranscription()
    await Promise.all([transcription, segmentation])

    expect(order).toEqual(['transcription-start', 'transcription-end', 'segmentation-start'])
  })

  it('serializes local processing when Windows runtime pressure checks require it', async () => {
    const coordinator = new LocalProcessingCoordinator(async () =>
      shouldSerializeWindowsLocalProcessing(4, 16)
    )
    const order: string[] = []
    let releaseTranscription!: () => void

    const transcription = coordinator.runExclusive('transcription', 'm1', async () => {
      order.push('transcription-start')
      await new Promise<void>((resolve) => {
        releaseTranscription = resolve
      })
      order.push('transcription-end')
    })

    await vi.waitFor(() => {
      expect(order).toEqual(['transcription-start'])
    })

    const segmentation = coordinator.runExclusive('segmentation', 'm2', async () => {
      order.push('segmentation-start')
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['transcription-start'])

    releaseTranscription()
    await Promise.all([transcription, segmentation])

    expect(order).toEqual(['transcription-start', 'transcription-end', 'segmentation-start'])
  })
})
