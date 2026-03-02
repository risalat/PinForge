import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        popup: 'index.html',
        background: 'src/background/service-worker.ts',
        scraper: 'src/content/scraper.ts',
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
})
