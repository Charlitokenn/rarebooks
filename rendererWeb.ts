/**
 * Browser entry point for the Web target. Replaces main.ts/src/renderer/
 * (Electron-only) — see package.json's web build script and vite config.
 *
 * Deliberately does NOT reuse src/renderer.ts as-is: that file calls
 * registerIpcRendererListeners() and ipc.getEnv(), both Electron-only
 * (the `ipc` global comes from Electron's preload script and doesn't
 * exist in a browser). What IS shared with Desktop: App error handling
 * conventions, fyo itself (fyo/index.ts, unchanged), and Tailwind styling.
 *
 * Also deliberately does NOT import src/utils/language.ts: that file has
 * a top-level `import { fyo } from 'src/initFyo'` (the DESKTOP singleton,
 * hardcoded isElectron: true) and setLanguageMap() hardcodes that same
 * import internally rather than taking fyo as a parameter. Vite's dev
 * server doesn't tree-shake unused imports — merely importing anything
 * from that file evaluates initFyo.ts, which constructs a Fyo with
 * isElectron: true and immediately touches the `ipc` global, which
 * doesn't exist in a browser (ReferenceError: ipc is not defined).
 * Localization is out of scope for this feature (0001) regardless — see
 * Follow-up.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md (AC-6)
 */
import { createApp } from 'vue';
import { clerkPlugin } from '@clerk/vue';
import { fyo } from 'src/initFyoWeb';
import webRouter from 'src/web/router';
import './src/styles/index.css'; // Tailwind — same design tokens as Desktop, see colors.json

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

// Temporary diagnostic — remove once the Clerk setup is confirmed working.
// Masked so a real key never lands in full in the console/logs.
console.log(
  '[rendererWeb] VITE_CLERK_PUBLISHABLE_KEY:',
  PUBLISHABLE_KEY
    ? `${PUBLISHABLE_KEY.slice(0, 12)}… (${PUBLISHABLE_KEY.length} chars, starts with "${PUBLISHABLE_KEY.slice(0, 8)}")`
    : `MISSING (value is: ${JSON.stringify(PUBLISHABLE_KEY)})`
);

if (!PUBLISHABLE_KEY) {
  throw new Error(
    'VITE_CLERK_PUBLISHABLE_KEY is not set — required for the Web target (see worker/wrangler.toml for the matching CLERK_PUBLISHABLE_KEY Worker secret)'
  );
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async () => {
  // English only for now — see this file's docblock and Follow-up in
  // docs/specs/0001 re: src/utils/language.ts needing to accept fyo as a
  // parameter before it's safe to reuse here.
  fyo.store.language = 'English';
  fyo.store.platform = 'Web';

  const app = createApp({
    template: '<router-view />',
  });

  app.use(webRouter);

  const clerkOptions = {
    publishableKey: PUBLISHABLE_KEY,
    signInFallbackRedirectUrl: '/dashboard',
    signUpFallbackRedirectUrl: '/create-organization',
  };
  // Temporary diagnostic — remove once confirmed working. Logs the exact
  // object clerkPlugin.install() receives, not just the key in isolation.
  console.log('[rendererWeb] clerkPlugin options:', {
    ...clerkOptions,
    publishableKey: clerkOptions.publishableKey
      ? `${clerkOptions.publishableKey.slice(0, 12)}…`
      : clerkOptions.publishableKey,
  });
  app.use(clerkPlugin, clerkOptions);

  app.mixin({
    computed: {
      fyo() {
        return fyo;
      },
      platform() {
        return 'Web';
      },
    },
    methods: {
      t: fyo.t,
      T: fyo.T,
    },
  });

  app.mount('body');
})();