import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['src/main/**/*.{test,spec}.{ts,tsx}'],
    passWithNoTests: true,
  },
})
