import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs separately (npm run server:dev); proxy /api to it so the
// browser sees one origin. Override the target with API_PROXY_TARGET if needed.
const target = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': target } },
  preview: { proxy: { '/api': target } },
});
