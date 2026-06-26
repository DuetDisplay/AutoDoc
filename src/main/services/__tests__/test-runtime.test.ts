import { describe, expect, it } from 'vitest'
import { getScopedTestUserDataDir, isScopedTestRuntime } from '../test-runtime'

describe('test runtime scoping', () => {
  it('ignores AUTODOC_TEST_USER_DATA_DIR during normal dev runs', () => {
    const env = {
      AUTODOC_TEST_USER_DATA_DIR: '/tmp/autodoc-tcc-smoke-user-data',
      NODE_ENV: 'development'
    } as NodeJS.ProcessEnv

    expect(isScopedTestRuntime(env)).toBe(false)
    expect(getScopedTestUserDataDir(env)).toBeNull()
  })

  it('honors AUTODOC_TEST_USER_DATA_DIR for explicit test runs', () => {
    const env = {
      AUTODOC_TEST_USER_DATA_DIR: '/tmp/autodoc-tcc-smoke-user-data',
      AUTODOC_TEST_MODE: '1'
    } as NodeJS.ProcessEnv

    expect(isScopedTestRuntime(env)).toBe(true)
    expect(getScopedTestUserDataDir(env)).toBe('/tmp/autodoc-tcc-smoke-user-data')
  })

  it('honors AUTODOC_TEST_USER_DATA_DIR for e2e runs', () => {
    const env = {
      AUTODOC_TEST_USER_DATA_DIR: '/tmp/autodoc-e2e-user-data',
      AUTODOC_E2E: '1'
    } as NodeJS.ProcessEnv

    expect(isScopedTestRuntime(env)).toBe(true)
    expect(getScopedTestUserDataDir(env)).toBe('/tmp/autodoc-e2e-user-data')
  })
})
