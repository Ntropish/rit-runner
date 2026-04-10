import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api/': 'http://localhost:3001',
      '/login': 'http://localhost:3001',
      '/callback': 'http://localhost:3001',
      '/refresh': 'http://localhost:3001',
    },
  },
  build: {
    outDir: '../dist/client',
  },
});
