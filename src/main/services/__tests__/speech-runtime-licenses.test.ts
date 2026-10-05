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

it('keeps rebuild-dependent Windows entries pending and excludes unbundled Vulkan/TensorRT binaries', () => {
  const notices = windowsInventory.notices
  for (const name of [
    'av',
    'huggingface_hub',
    'PyAV / FFmpeg codec DLLs',
    'onnxruntime/capi/onnxruntime_providers_tensorrt.dll'
  ]) {
    expect(
      notices
        .filter((notice) => notice.name === name)
        .every((notice) => notice.license === 'Pending final inventory')
    ).toBe(true)
  }
  expect(notices.some((notice) => notice.name === 'vulkan-1.dll')).toBe(false)
  expect(notices.some((notice) => /nvinfer/.test(notice.name))).toBe(false)
})
