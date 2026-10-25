import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Gera duas páginas: a Activity (index.html) e o Estúdio do dono (studio.html).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        studio: fileURLToPath(new URL('./studio.html', import.meta.url)),
      },
    },
  },
});
