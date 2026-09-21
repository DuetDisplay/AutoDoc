import { readFile, writeFile, rename } from 'fs/promises'

interface WindowsDmlRestriction {
  version: 1
  backend: 'parakeet-cpu'
  reason: 'gpu-failure'
}

/** Stored inside the recording directory; never restricts another recording. */
export async function readDmlRestriction(path: string): Promise<WindowsDmlRestriction | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value?.version === 1 && value.backend === 'parakeet-cpu' && value.reason === 'gpu-failure')
      return value
    throw new Error('Unrecognized recording CPU recovery pin')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeDmlRestriction(path: string): Promise<void> {
  const temporary = path + '.tmp'
  await writeFile(
    temporary,
    JSON.stringify({
      version: 1,
      backend: 'parakeet-cpu',
      reason: 'gpu-failure'
    } satisfies WindowsDmlRestriction)
  )
  await rename(temporary, path)
}
