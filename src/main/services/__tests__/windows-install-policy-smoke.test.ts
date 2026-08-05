import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getScopedTestUserDataDir } from '../test-runtime'

describe('Windows install-policy smoke profile isolation', () => {
  it('uses a relaunch-safe scoped runtime for its temporary profile', () => {
    const script = readFileSync(
      resolve(process.cwd(), 'scripts/windows-install-policy-smoke.ps1'),
      'utf8'
    )
    const scopeAssignment = "$env:AUTODOC_TEST_REAL_SETUP = '1'"
    const profileAssignment = '$env:AUTODOC_TEST_USER_DATA_DIR = $UserDataDir'

    expect(script.indexOf(scopeAssignment)).toBeGreaterThanOrEqual(0)
    expect(script.indexOf(profileAssignment)).toBeGreaterThan(script.indexOf(scopeAssignment))
    expect(script).toContain('Remove-Item Env:AUTODOC_TEST_REAL_SETUP')
    expect(
      getScopedTestUserDataDir({
        AUTODOC_TEST_REAL_SETUP: '1',
        AUTODOC_TEST_USER_DATA_DIR: 'C:\\Temp\\autodoc-smoke-user-data'
      })
    ).toBe('C:\\Temp\\autodoc-smoke-user-data')
  })
})
