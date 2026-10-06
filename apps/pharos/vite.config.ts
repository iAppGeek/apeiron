import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const API_TARGET = process.env.API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The page always talks to /ws on its own origin; nginx does this in production.
    proxy: { '/ws': { target: API_TARGET, ws: true, changeOrigin: true } },
  },
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.spec.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    css: false,
  },
});
