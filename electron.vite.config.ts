import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    define: {
      'process.env.AUTODOC_SENTRY_DSN': JSON.stringify(process.env.AUTODOC_SENTRY_DSN ?? ''),
    },
    build: {
      externalizeDeps: {
        exclude: ['electron-store'],
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [
      tailwindcss(),
      react()
    ]
  }
})
