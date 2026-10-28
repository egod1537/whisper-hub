import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const environment = loadEnv(mode, repositoryRoot, '');
  const apiKey = process.env.API_KEY ?? environment.API_KEY;
  const target = process.env.VITE_PROXY_TARGET ?? environment.VITE_PROXY_TARGET ?? 'http://127.0.0.1:3000';
  const authenticatedHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy: {
        '/api': { target, changeOrigin: false, headers: authenticatedHeaders },
        '/health': { target, changeOrigin: false },
      },
    },
  };
});
