import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/notes-ia/__tests__/**/*.test.ts']
  }
})
