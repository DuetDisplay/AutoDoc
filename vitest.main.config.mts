import { defineConfig } from 'vitest/config'

const retrievalTests = 'src/main/services/__tests__/chat-retrieval.test.ts'

export default defineConfig({
  define: {
    __AUTODOC_QA_BUILD__: false
  },
  test: {
    globals: true,
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['src/main/**/*.{test,spec}.{ts,tsx}', 'src/shared/**/*.{test,spec}.{ts,tsx}'],
          exclude: [retrievalTests, '**/._*']
        }
      },
      {
        extends: true,
        test: {
          name: 'retrieval',
          include: [retrievalTests],
          // Measure the 50 ms warm-query budgets after other CPU/disk workers finish.
          sequence: { groupOrder: 1 }
        }
      }
    ]
  }
})
