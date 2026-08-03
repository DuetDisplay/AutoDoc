import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const qaBuild = mode === 'qa'
  const feedbackPromptQA = qaBuild || env.AUTODOC_FEEDBACK_PROMPT_QA === '1'
  const officialBuild = qaBuild ? '' : (env.AUTODOC_OFFICIAL_BUILD ?? '')
  const buildFlags = {
    __AUTODOC_QA_BUILD__: JSON.stringify(qaBuild),
    __AUTODOC_FEEDBACK_PROMPT_QA__: JSON.stringify(feedbackPromptQA)
  }

  return {
    main: {
      define: {
        ...buildFlags,
        'process.env.AUTODOC_SENTRY_DSN': JSON.stringify(env.AUTODOC_SENTRY_DSN ?? ''),
        'process.env.AUTODOC_SENTRY_DEV': JSON.stringify(env.AUTODOC_SENTRY_DEV ?? ''),
        'process.env.AUTODOC_AUTH_WORKER_URL': JSON.stringify(env.AUTODOC_AUTH_WORKER_URL ?? ''),
        'process.env.AUTODOC_SUPPORT_EMAIL': JSON.stringify(
          env.AUTODOC_SUPPORT_EMAIL ?? (qaBuild ? 'team@getautodoc.com' : '')
        ),
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
        )
      },
      build: {
        externalizeDeps: {
          exclude: ['electron-store']
        }
      }
    },
    preload: {},
    renderer: {
      define: buildFlags,
      plugins: [tailwindcss(), react()]
    }
  }
})
