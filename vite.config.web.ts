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
  build: {
    outDir: path.resolve(__dirname, './dist_web'),
    rollupOptions: {
      input: path.resolve(__dirname, './index.html'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/webhooks': 'http://localhost:8787',
    },
  },
  plugins: [vue()],
  resolve: {
    alias: {
      vue: 'vue/dist/vue.esm-bundler.js',
      // Spec 0008 AC-7: the desktop chrome's two shared module paths
      // resolve to web variants in the web bundle only; the desktop
      // bundle never sees these. Both must be listed BEFORE the broad
      // `src` prefix alias below — Vite string aliases match by prefix,
      // so `src` alone would swallow them. Rollup's exact-or-'/'-boundary
      // matching keeps `src/initFyo` from swallowing `src/initFyoWeb`.
      'src/initFyo': path.resolve(__dirname, './src/initFyoWeb.ts'),
      'src/router': path.resolve(__dirname, './src/web/router.ts'),
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
