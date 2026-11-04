import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Календарь работает внутри портала по адресу /calendar/
export default defineConfig({
  base: '/calendar/',
  plugins: [react()],
  build: { outDir: '../../public/calendar', emptyOutDir: true },
  server: {
    port: 5174,
    proxy: { '/calendar/api': 'http://localhost:3000', '/api': 'http://localhost:3000', '/login': 'http://localhost:3000' },
  },
});
