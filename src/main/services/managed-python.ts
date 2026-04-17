export const MANAGED_PYTHON_RELEASE_TAG = '20260414'
export const MANAGED_PYTHON_VERSION = '3.11.15'

export interface ManagedPythonTarget {
  key: string
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  triplet: string
  executableRelativePath: string[]
}

const MANAGED_PYTHON_TARGETS: ManagedPythonTarget[] = [
  {
    key: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    triplet: 'aarch64-apple-darwin',
    executableRelativePath: ['python', 'bin', 'python3'],
  },
  {
    key: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    triplet: 'x86_64-apple-darwin',
    executableRelativePath: ['python', 'bin', 'python3'],
  },
  {
    key: 'win32-arm64',
    platform: 'win32',
    arch: 'arm64',
    triplet: 'aarch64-pc-windows-msvc',
    executableRelativePath: ['python', 'python.exe'],
  },
  {
    key: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    triplet: 'x86_64-pc-windows-msvc',
    executableRelativePath: ['python', 'python.exe'],
  },
]

export function getManagedPythonTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): ManagedPythonTarget | null {
  return MANAGED_PYTHON_TARGETS.find((target) => target.platform === platform && target.arch === arch) ?? null
}

export function getManagedPythonArchiveFilename(target: ManagedPythonTarget): string {
  return `cpython-${MANAGED_PYTHON_VERSION}+${MANAGED_PYTHON_RELEASE_TAG}-${target.triplet}-install_only.tar.gz`
}

export function getManagedPythonDownloadUrl(target: ManagedPythonTarget): string {
  const encodedVersion = `${MANAGED_PYTHON_VERSION}%2B${MANAGED_PYTHON_RELEASE_TAG}`
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${MANAGED_PYTHON_RELEASE_TAG}/cpython-${encodedVersion}-${target.triplet}-install_only.tar.gz`
}
