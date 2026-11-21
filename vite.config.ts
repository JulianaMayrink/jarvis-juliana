import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Loopback only: the bridge trusts 127.0.0.1, so the UI is served there too.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
})
