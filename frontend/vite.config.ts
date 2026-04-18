import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'
import portsConfig from '../ports.config.json'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      [path.resolve(__dirname, 'node_modules/@pierre/diffs/node_modules/shiki/dist/bundle-full.mjs')]:
        path.resolve(__dirname, 'node_modules/@pierre/diffs/node_modules/shiki/dist/bundle-web.mjs'),
      [path.resolve(__dirname, 'node_modules/@pierre/diffs/node_modules/shiki/dist/langs.mjs')]:
        path.resolve(__dirname, 'src/shims/shiki-langs-noop.mjs'),
    },
  },
  server: {
    port: portsConfig.frontend.dev,
    proxy: {
      '/api': {
        target: `http://localhost:${portsConfig.backend.dev}`,
        changeOrigin: true,
      },
    },
  },
  base: './',
  build: {
    outDir: 'dist',
  },
})
