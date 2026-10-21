import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // sharp/canvas — лише для Node-шляху воркера (exportDocx.js), динамічний
    // import(), що ніколи не виконується в браузері (typeof document guard).
    // Rollup все одно намагається їх резолвити при білді — явно виключаємо.
    rollupOptions: { external: ["sharp", "canvas"] },
  },
})
