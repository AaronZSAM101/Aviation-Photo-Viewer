import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: backendTarget, changeOrigin: true },
      '/photos': { target: backendTarget, changeOrigin: true },
      '/preview': { target: backendTarget, changeOrigin: true },
      '/thumb': { target: backendTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
