import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import Pages from 'vite-plugin-pages';
import terminal from 'vite-plugin-terminal';
import path from 'path';

export default defineConfig(({ mode }) => {
  const backendPort = process.env.BACKEND_PORT;
  const backendEnabled = backendPort && backendPort !== 'NONE';

  return {
    plugins: [
      react(),
      Pages({ dirs: 'src/pages', extensions: ['tsx'] }),
      terminal({ console: 'terminal', output: ['terminal', 'console'] }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    define: {
      'process.env.BACKEND_ENABLED': JSON.stringify(backendEnabled ? 'true' : ''),
    },
    server: {
      port: Number(process.env.FRONTEND_PORT) || 3000,
      open: true,
      proxy: backendEnabled
        ? {
            '/api': {
              target: `http://localhost:${backendPort || 8324}`,
              changeOrigin: true,
            },
          }
        : undefined,
    },
  };
});
