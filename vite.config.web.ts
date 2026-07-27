import vue from '@vitejs/plugin-vue';
import path from 'path';
import { defineConfig } from 'vite';

/**
 * Separate build config for the web target - deliberately independent of vite.config.ts
 * (which is Electron-dev-server-only, per its own comment) and build/scripts/build.mjs
 * (which drives electron-builder packaging - none of that applies here).
 *
 * Usage:
 *   npx vite build --config vite.config.web.ts
 * Output goes to dist-web/, deployable as a static site (Cloudflare Pages - see Phase 7a).
 *
 * Needs a .env.web (or .env) with:
 *   VITE_API_BASE_URL=https://api.rarebooks.cc          (or your rarebooks-api Worker's *.workers.dev URL for now)
 *   VITE_CLERK_PUBLISHABLE_KEY=pk_...                     (same Clerk app rarebooks-site already uses)
 */
export default defineConfig({
  root: path.resolve(__dirname, './src'),
  envDir: path.resolve(__dirname), // read .env files from the repo root, not src/
  build: {
    outDir: path.resolve(__dirname, './dist-web'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, './src/index.web.html'),
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
      dummy: path.resolve(__dirname, './dummy'),
      fixtures: path.resolve(__dirname, './fixtures'),
      custom: path.resolve(__dirname, './custom'),
    },
  },
});
