import * as Sentry from '@sentry/electron/renderer'
import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource/instrument-serif'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

async function bootstrap(): Promise<void> {
  const consent = await window.electronAPI.invoke('prefs:get-analytics-consent').catch(() => null)
  if (consent === true) {
    Sentry.init()
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
