// Electron loads this CommonJS preload with -r before the application entry point.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('electron')
const home = process.env.AUTODOC_E2E_SYNTHETIC_HOME
if (!home) throw new Error('A synthetic home is required for the isolation regression')
app.setPath('home', home)
if (app.getPath('home') !== home) throw new Error('Synthetic home override failed')
