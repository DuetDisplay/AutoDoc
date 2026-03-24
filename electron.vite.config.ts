import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
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
