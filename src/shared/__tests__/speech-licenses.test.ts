import { describe, expect, it } from 'vitest'
import { speechLicenseNotices } from '../speech-licenses'

describe('speech license attributions', () => {
  it('attributes converted NVIDIA model weights with the CC-BY license and model source', () => {
    const windows = speechLicenseNotices('win32')
    for (const name of ['Canary-1B-v2', 'Parakeet TDT 0.6B v3']) {
      expect(windows.find((notice) => notice.name === name)).toMatchObject({
        license: 'CC-BY-4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        url: expect.stringContaining('huggingface.co/nvidia/'),
        attribution: expect.stringContaining('NVIDIA')
      })
    }
  })
  it('keeps platform-specific runtimes out of the other platform notices', () => {
    const mac = speechLicenseNotices('darwin').map(({ name }) => name)
    const windows = speechLicenseNotices('win32').map(({ name }) => name)
    expect(mac).toContain('mlx-audio')
    expect(mac).not.toContain('Parakeet TDT 0.6B v3')
    expect(mac).not.toContain('NVIDIA cuDNN redistributables')
    expect(mac).not.toContain('CTranslate2')
    expect(windows).toContain('NVIDIA cuDNN redistributables')
    expect(windows).not.toContain('MLX')
    expect(windows).not.toContain('mlx-whisper')
    expect(speechLicenseNotices('linux')).toEqual([])
  })
})
