import { describe, expect, it, vi } from 'vitest'
import { LocalProcessingCoordinator } from '../local-processing-coordinator'
import { shouldSerializeWindowsLocalProcessing } from '../windows-transcription-runtime'

describe('LocalProcessingCoordinator', () => {
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
