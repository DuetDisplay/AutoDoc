import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/notes-writer-probe/__tests__/**/*.test.ts']
  }
})
