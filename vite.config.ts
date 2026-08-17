import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // The UI imports regulatory constants straight from server/rules so the
    // net-contents picker and the check that validates it cannot drift apart.
    // That file sits outside the Vite root, so the dev server needs to be told
    // it may read the project directory.
    fs: { allow: ['..'] },
    proxy: {
      // Same-origin in production, proxied in dev — the frontend never needs to
      // know an API host, and there is no CORS configuration anywhere.
      '/api': 'http://localhost:3001',
    },
  },
});
