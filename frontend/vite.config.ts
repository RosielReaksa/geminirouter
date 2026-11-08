import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  build: {
    // Split the React runtime and the icon set out of the application bundle.
    // One 560 kB chunk is re-downloaded in full on every app change; vendor code
    // is stable, so it caches independently and each chunk stays small.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'react';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'icons';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The bridge serves the dashboard and /api on WEB_PORT (3000 by default,
      // see deploy/.env.example). 8080 was a stale value that made `pnpm dev`
      // proxy to nothing.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
