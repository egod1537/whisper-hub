import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: false },
      '/health': { target: process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
