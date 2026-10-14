import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SpeechLicenses } from './SpeechLicenses'

beforeEach(() => {
  vi.mocked(window.electronAPI.invoke).mockResolvedValue([
    {
      name: 'onnx-asr',
      version: '0.12.0',
      license: 'MIT',
      runtime: 'canary-mlx-runtime',
      url: 'https://pypi.org/project/onnx-asr/0.12.0/',
      text: 'Copyright (c) onnx-asr contributors'
    }
  ])
})
it('shows model attribution and the bundled package license text without fetching network data', async () => {
  render(<SpeechLicenses platform="darwin" />)
  expect(screen.getByRole('link', { name: 'Canary-1B-v2' })).toHaveAttribute(
    'href',
    'https://huggingface.co/nvidia/canary-1b-v2'
  )
  expect(await screen.findByText(/onnx-asr 0.12.0/)).toBeInTheDocument()
  expect(screen.getByText('Copyright (c) onnx-asr contributors')).toBeInTheDocument()
  expect(window.electronAPI.invoke).toHaveBeenCalledWith('app:get-speech-runtime-licenses')
  expect(
    screen.queryByRole('link', { name: 'NVIDIA CUDA redistributables' })
  ).not.toBeInTheDocument()
})
it('keeps model notices readable when a development package inventory is absent', async () => {
  vi.mocked(window.electronAPI.invoke).mockRejectedValue(new Error('ENOENT'))
  render(<SpeechLicenses platform="win32" />)
  expect(await screen.findByRole('status')).toHaveTextContent('unavailable')
  expect(screen.getByRole('link', { name: 'Parakeet TDT 0.6B v3' })).toBeInTheDocument()
})
