import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { getResetLocalDataTargets, isSafeTestResetPath } from '../reset-local-data'

describe('reset-local-data safety rails', () => {
  it('allows only temp AutoDoc test paths during test resets', () => {
    const safePaths = [
      join(tmpdir(), 'autodoc-e2e-12345'),
      join(tmpdir(), 'autodoc-e2e-isolated-12345'),
      join(tmpdir(), 'autodoc-real-setup-12345'),
      join(tmpdir(), 'autodoc-smoke-user-data-12345')
    ]

    for (const targetPath of safePaths) {
      expect(isSafeTestResetPath(targetPath)).toBe(true)
    }
  })

  it('rejects non-temp or ambiguous test reset paths', () => {
    expect(isSafeTestResetPath('/Users/chris/Library/Application Support/AutoDoc')).toBe(false)
    expect(isSafeTestResetPath(join(tmpdir(), 'AutoDoc'))).toBe(false)
  })

  it('limits test resets to the isolated test userData dir', () => {
    const testUserDataPath = join(tmpdir(), 'autodoc-e2e-isolated-12345')

    expect(
      getResetLocalDataTargets({
        userDataPath: testUserDataPath,
        appDataPath: '/Users/chris/Library/Application Support',
        testUserDataDir: testUserDataPath,
        isE2E: true
      })
    ).toEqual([testUserDataPath])
  })

  it('refuses to reset local data for unsafe test paths', () => {
    expect(() =>
      getResetLocalDataTargets({
        userDataPath: '/Users/chris/Library/Application Support/AutoDoc',
        appDataPath: '/Users/chris/Library/Application Support',
        testUserDataDir: '/Users/chris/Library/Application Support/AutoDoc',
        isE2E: true
      })
    ).toThrow(/Refusing to reset local data/)
  })

  it('keeps production reset targets unchanged', () => {
    expect(
      getResetLocalDataTargets({
        userDataPath: '/Users/chris/Library/Application Support/AutoDoc',
        appDataPath: '/Users/chris/Library/Application Support'
      })
    ).toEqual([
      '/Users/chris/Library/Application Support/AutoDoc',
      '/Users/chris/Library/Application Support/autodoc',
      '/Users/chris/Library/Application Support/Autodoc'
    ])
  })

  it('limits QA resets to the isolated AutoDoc QA profile', () => {
    expect(
      getResetLocalDataTargets({
        userDataPath: '/Users/chris/Library/Application Support/AutoDoc QA',
        appDataPath: '/Users/chris/Library/Application Support',
        isQABuild: true
      })
    ).toEqual(['/Users/chris/Library/Application Support/AutoDoc QA'])
  })

  it('refuses to let a QA reset target production data', () => {
    expect(() =>
      getResetLocalDataTargets({
        userDataPath: '/Users/chris/Library/Application Support/AutoDoc',
        appDataPath: '/Users/chris/Library/Application Support',
        isQABuild: true
      })
    ).toThrow(/Refusing to reset QA data outside its isolated profile/)
  })
})
