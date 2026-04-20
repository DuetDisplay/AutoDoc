import { describe, it, expect } from 'vitest'
import {
  MANAGED_PYTHON_RELEASE_TAG,
  MANAGED_PYTHON_VERSION,
  getManagedPythonArchiveFilename,
  getManagedPythonDownloadUrl,
  getManagedPythonTarget,
} from '../managed-python'

describe('managed Python runtime manifest', () => {
  it('maps macOS arm64 to the correct standalone target', () => {
    const target = getManagedPythonTarget('darwin', 'arm64')

    expect(target).toMatchObject({
      key: 'darwin-arm64',
      triplet: 'aarch64-apple-darwin',
      executableRelativePath: ['python', 'bin', 'python3'],
    })
  })

  it('maps Windows x64 to the correct standalone target', () => {
    const target = getManagedPythonTarget('win32', 'x64')

    expect(target).toMatchObject({
      key: 'win32-x64',
      triplet: 'x86_64-pc-windows-msvc',
      executableRelativePath: ['python', 'python.exe'],
    })
  })

  it('builds a pinned archive filename and download URL', () => {
    const target = getManagedPythonTarget('darwin', 'x64')
    expect(target).not.toBeNull()

    expect(getManagedPythonArchiveFilename(target!)).toBe(
      `cpython-${MANAGED_PYTHON_VERSION}+${MANAGED_PYTHON_RELEASE_TAG}-x86_64-apple-darwin-install_only.tar.gz`,
    )
    expect(getManagedPythonDownloadUrl(target!)).toBe(
      `https://github.com/astral-sh/python-build-standalone/releases/download/${MANAGED_PYTHON_RELEASE_TAG}/cpython-${MANAGED_PYTHON_VERSION}%2B${MANAGED_PYTHON_RELEASE_TAG}-x86_64-apple-darwin-install_only.tar.gz`,
    )
  })

  it('returns null for unsupported platforms', () => {
    expect(getManagedPythonTarget('linux', 'x64')).toBeNull()
  })
})
