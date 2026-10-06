import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { speechRuntimeLicenseNotices } from '../speech-runtime-licenses'
import windowsInventory from '../../../../resources/windows-speech-runtime-licenses.json'

let runtimePackaged = false
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return runtimePackaged
    },
    getAppPath: () => '/app'
  }
}))
vi.mock('fs/promises', () => ({ readFile: vi.fn() }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', arch)
  if (resources) Object.defineProperty(process, 'resourcesPath', resources)
  else Reflect.deleteProperty(process, 'resourcesPath')
})

it.each([false, true])('reads Windows notices locally (packaged: %s)', async (packaged) => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' })
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/resources' })
  runtimePackaged = packaged
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(windowsInventory))
  expect(await speechRuntimeLicenseNotices()).toEqual(windowsInventory.notices)
  expect(readFile).toHaveBeenLastCalledWith(
    packaged
      ? join('/resources', 'speech-runtime-licenses', 'win32-x64.json')
      : join('/app', 'resources', 'windows-speech-runtime-licenses.json'),
    'utf8'
  )
})

it('lists the rebuilt Windows runtimes without removed codecs, Hub trees or TensorRT', () => {
  const notices = windowsInventory.notices
  expect(
    notices.some((notice) => /^(av|vulkan-1.dll)$|PyAV|FFmpeg|tensorrt|nvinfer/i.test(notice.name))
  ).toBe(false)
  expect(notices.some((notice) => notice.license === 'Pending final inventory')).toBe(false)
  expect(notices.filter((notice) => notice.name === 'huggingface_hub')).toEqual([
    expect.objectContaining({
      runtime: 'faster-whisper CPU / CUDA (v3)',
      version: '1.14.0',
      license: 'Apache-2.0'
    })
  ])
  expect(
    notices
      .filter((notice) => notice.runtime === 'Canary CUDA')
      .some((notice) => ['sympy', 'mpmath'].includes(notice.name))
  ).toBe(false)
  expect(notices).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'nvidia-nvjitlink-cu12',
        version: '12.9.86',
        license: 'LicenseRef-NVIDIA-Proprietary',
        runtime: 'Canary CUDA'
      }),
      expect.objectContaining({
        name: 'nvidia/nvjitlink/bin/nvJitLink_120_0.dll',
        version: '12.9.86',
        license: 'NVIDIA proprietary',
        runtime: 'Canary CUDA'
      })
    ])
  )
})
