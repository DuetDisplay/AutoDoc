export function isScopedTestRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.AUTODOC_E2E === '1' ||
    env.AUTODOC_TEST_REAL_SETUP === '1' ||
    env.AUTODOC_TEST_MODE === '1' ||
    env.NODE_ENV === 'test'
  )
}

export function getScopedTestUserDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const configuredDir = env.AUTODOC_TEST_USER_DATA_DIR?.trim()
  if (!configuredDir) {
    return null
  }

  return isScopedTestRuntime(env) ? configuredDir : null
}
