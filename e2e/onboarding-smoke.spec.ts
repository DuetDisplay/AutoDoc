import { existsSync } from 'node:fs'
import path from 'node:path'
import { test, expect, _electron as electron } from '@playwright/test'

test('launches to the onboarding welcome step in e2e mode', async () => {
  const mainEntry = path.join(process.cwd(), 'out', 'main', 'index.js')
  expect(existsSync(mainEntry)).toBeTruthy()

  const electronApp = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AUTODOC_E2E: '1',
      NODE_ENV: 'test',
    },
  })

  try {
    const page = await electronApp.firstWindow()

    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
    await expect(page.getByRole('button', { name: /get started/i })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
