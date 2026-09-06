import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* In dev the browser talks to Vite, which proxies to the services; in Docker nginx does the same
   job with the same paths. Keeping ONE set of paths (/api/*) means no code changes between the
   two, and no CORS anywhere — the page and the data share an origin either way. */
const target = (env, fallback) => process.env[env] || fallback;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api/sim':  { target: target('SIM_URL',  'http://localhost:4841'), changeOrigin: true, rewrite: p => p.replace(/^\/api\/sim/, '') },
      '/api/orch': { target: target('ORCH_URL', 'http://localhost:8099'), changeOrigin: true, rewrite: p => p.replace(/^\/api\/orch/, '') },
      '/api/edge': { target: target('EDGE_URL', 'http://localhost:5510'), changeOrigin: true, rewrite: p => p.replace(/^\/api\/edge/, '') },
      '/api/hist': { target: target('HIST_URL', 'http://localhost:8098'), changeOrigin: true, rewrite: p => p.replace(/^\/api\/hist/, '') }
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});
