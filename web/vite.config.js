import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// En développement, l'API tourne à part (npm run dev dans server/) : Vite lui relaie les appels /api
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: { '/api': 'http://localhost:8080' },
  },
});
