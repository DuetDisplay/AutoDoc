import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    __AUTODOC_QA_BUILD__: false,
    __AUTODOC_FEEDBACK_PROMPT_QA__: false
  },
  test: {
    globals: true,
    include: ['src/main/**/*.{test,spec}.{ts,tsx}'],
    passWithNoTests: true
  }
})
