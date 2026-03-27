import * as Sentry from '@sentry/electron/renderer'
import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource/instrument-serif'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Renderer-side Sentry — pairs with main process init, shares the same DSN
Sentry.init()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
