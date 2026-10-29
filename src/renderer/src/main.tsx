import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource/instrument-serif'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './services/appearance'
import { applyDocumentLanguage } from './services/document-language'
import './assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './services/i18n'
import { bootstrapRendererSentry } from './services/renderer-sentry'
import { ThemeProvider } from './services/theme'

async function bootstrap(): Promise<void> {
  // Resolve main's seeded preference before React's first frame, including a fresh profile.
  const initialLanguage = await window.electronAPI.invoke('prefs:get-ui-language')
  applyDocumentLanguage(initialLanguage)
  const consent = await window.electronAPI.invoke('prefs:get-analytics-consent').catch(() => null)
  bootstrapRendererSentry(consent === true)

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeProvider>
        <I18nProvider>
          <App />
        </I18nProvider>
      </ThemeProvider>
    </React.StrictMode>
  )
}

void bootstrap()
