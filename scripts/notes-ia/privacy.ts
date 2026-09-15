import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

export async function writePrivateFile(
  filePath: string,
  contents: string,
  mode = 0o600
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath))
  await writeFile(filePath, contents, { encoding: 'utf8', mode })
  await chmod(filePath, mode)
  const metadata = await lstat(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Private output validation failed.')
  }
}

export async function writePrivateJson(filePath: string, value: unknown, mode = 0o600): Promise<void> {
  const serialized = JSON.stringify(value, null, 2)
  if (typeof serialized !== 'string') throw new Error('Value is not JSON-serializable.')
  await writePrivateFile(filePath, `${serialized}\n`, mode)
}
