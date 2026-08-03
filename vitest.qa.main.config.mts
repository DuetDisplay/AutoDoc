import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    __AUTODOC_QA_BUILD__: true
  },
  test: {
    globals: true,
    include: ['src/main/services/__tests__/qa-build-isolation.test.ts'],
    passWithNoTests: false
  }
})
