import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Реестр документов работает внутри портала по адресу /docs/
export default defineConfig({
  base: '/docs/',
  plugins: [react()],
  build: { outDir: '../../public/docs', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/docs/api': 'http://localhost:3000', '/api': 'http://localhost:3000', '/login': 'http://localhost:3000' },
  },
});
