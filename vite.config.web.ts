import vue from '@vitejs/plugin-vue';
import path from 'path';
import { defineConfig } from 'vite';

/**
 * Vite config for the Web target (rendererWeb.ts / index.html), kept
 * separate from vite.config.ts — that one's `root` is `src/` and serves
 * renderer.ts for Electron's dev server; this one's `root` is the repo
 * root, since rendererWeb.ts and index.html live there per
 * context/architecture.md's target layout.
 *
 * The HTML entry here MUST be named index.html, not index.web.html as an
 * earlier version of this file had it: Vite's dev server only auto-serves
 * a file literally named index.html at the configured root — anything
 * else 404s at `/` and is only reachable by navigating to its exact
 * filename. There's no existing index.html at repo root to collide with
 * (Desktop's is at src/index.html, a different root).
 *
 * Dev: `vite --config vite.config.web.ts`
 * Build: `vite build --config vite.config.web.ts` (outputs to dist_web/)
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md
 */
export default defineConfig({
  root: __dirname,
  server: {
    proxy: {
      // wrangler dev's default port. Without this, fetch('/api/...') from
      // the browser resolves against Vite's own dev server (5173), which
      // has no such route — and since Vite's default appType is 'spa', it
      // silently falls back to serving index.html (200 OK) instead of a
      // real 404. That HTML then fails to parse as JSON in Dashboard.vue's
      // fetch, gets swallowed by its .catch(() => ({})), and the resulting
      // empty body renders as a blank page instead of a real status.
      '/api': 'http://localhost:8787',
      '/webhooks': 'http://localhost:8787',
    },
  },
  build: {
    outDir: path.resolve(__dirname, './dist_web'),
    rollupOptions: {
      input: path.resolve(__dirname, './index.html'),
    },
  },
  plugins: [vue()],
  resolve: {
    alias: {
      vue: 'vue/dist/vue.esm-bundler.js',
      fyo: path.resolve(__dirname, './fyo'),
      src: path.resolve(__dirname, './src'),
      schemas: path.resolve(__dirname, './schemas'),
      backend: path.resolve(__dirname, './backend'),
      models: path.resolve(__dirname, './models'),
      utils: path.resolve(__dirname, './utils'),
      regional: path.resolve(__dirname, './regional'),
      reports: path.resolve(__dirname, './reports'),
      custom: path.resolve(__dirname, './custom'),
    },
  },
});