import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const officialBuild = env.AUTODOC_OFFICIAL_BUILD ?? ''

  return {
    main: {
      define: {
        'process.env.AUTODOC_SENTRY_DSN': JSON.stringify(env.AUTODOC_SENTRY_DSN ?? ''),
        'process.env.AUTODOC_SENTRY_DEV': JSON.stringify(env.AUTODOC_SENTRY_DEV ?? ''),
        'process.env.AUTODOC_AUTH_WORKER_URL': JSON.stringify(env.AUTODOC_AUTH_WORKER_URL ?? ''),
        'process.env.AUTODOC_OFFICIAL_BUILD': JSON.stringify(officialBuild),
        'process.env.AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL': JSON.stringify(
          env.AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL ?? ''
        ),
        'process.env.AUTODOC_MACOS_WHISPER_RUNTIME_RELEASE_TAG': JSON.stringify(
          env.AUTODOC_MACOS_WHISPER_RUNTIME_RELEASE_TAG ?? ''
        ),
        'process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL': JSON.stringify(
          env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL ?? ''
        ),
        'process.env.AUTODOC_WINDOWS_TRANSCRIPTION_RELEASE_TAG': JSON.stringify(
          env.AUTODOC_WINDOWS_TRANSCRIPTION_RELEASE_TAG ?? ''
        ),
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
