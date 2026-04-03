import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    main: {
      define: {
        'process.env.AUTODOC_SENTRY_DSN': JSON.stringify(env.AUTODOC_SENTRY_DSN ?? ''),
        'process.env.AUTODOC_SENTRY_DEV': JSON.stringify(env.AUTODOC_SENTRY_DEV ?? ''),
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
        react(),
      ],
    },
  }
})
