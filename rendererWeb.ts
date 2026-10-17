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
 * The src/utils/language.ts top-level-import blocker this file's docblock
 * used to describe is gone: the language loader now takes fyo as a
 * parameter (spec 0008 task 2), and `src/initFyo` resolves to the web
 * singleton via the vite.config.web.ts alias, so the desktop chrome
 * mounted under WebShell imports untouched.
 *
 * The root template mirrors src/App.vue's shell furniture the shared
 * components assume: the #app wrapper classes, :dir, and the persistent
 * #toast-container (Toast.vue teleports into it — the old bare
 * <router-view/> mount had none, so toasts had no target). The App.vue
 * provide set is replicated by WebShell.vue, which owns the chrome.
 *
 * Clerk is initialized via src/web/clerk.ts (bundled @clerk/clerk-js, not
 * @clerk/vue's clerkPlugin) — see that file's docblock for why. initClerk()
 * is awaited before the app mounts so route guards never see a transient
 * "not loaded yet" state on first paint.
 *
 * Specs: docs/specs/0001-web-platform-foundation-control-plane.md (AC-6),
 * docs/specs/0008-web-app-shell/index.md
 */
import { CUSTOM_EVENTS } from 'utils/messages';
import { UnexpectedLogObject } from 'utils/types';
import { computed, createApp, defineComponent } from 'vue';
import Badge from './src/components/Badge.vue';
import FeatherIcon from './src/components/FeatherIcon.vue';
import { handleError, sendError } from './src/errorHandling';
import { fyo } from 'src/initFyoWeb';
import { outsideClickDirective } from './src/renderer/helpers';
import { stringifyCircular } from './src/utils';
import router from 'src/router'; // aliased to src/web/router.ts on web
import { initClerk } from 'src/web/clerk';
import { initShellAuth } from 'src/web/shell';
import { initSubscriptionRedirect } from 'src/web/subscription';
import './src/styles/index.css'; // Tailwind — same design tokens as Desktop, see colors.json

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async () => {
  // English only for now — see Follow-up in docs/specs/0001; the loader is
  // web-safe either way now, this just never swaps the map.
  fyo.store.language = 'English';
  fyo.store.platform = 'Web';

  await initClerk();
  // Mirror Clerk session transitions into the shell boot state before the
  // first route resolves, so the guard sees a settled org (AC-5).
  initShellAuth();

  const Root = defineComponent({
    setup() {
      // Shell pages own their scrolling; standalone pages (feature 0001's
      // billing/settings) keep the viewport scroll they had bare.
      const isStandaloneRoute = computed(
        () => !router.currentRoute.value.meta.shell
      );
      return { isStandaloneRoute };
    },
    template: `
      <div id="app" :class="[
        'dark:bg-gray-900 h-screen flex flex-col font-sans antialiased',
        // The shell provides its own internal scroll areas; the standalone
        // pages (billing, settings) scroll on the viewport as they did
        // before the shell existed.
        isStandaloneRoute ? 'overflow-y-auto' : 'overflow-hidden',
      ]">
        <router-view v-slot="{ Component }">
          <component :is="Component" :class="isStandaloneRoute ? 'shrink-0' : 'flex-1 min-h-0'" />
        </router-view>
        <!-- Render target for toasts (see App.vue on Desktop) -->
        <div id="toast-container" class="absolute bottom-0 flex flex-col items-end mb-3 pe-6" style="width: 100%; pointer-events: none"></div>
      </div>
    `,
  });

  const app = createApp(Root);

  setErrorHandlers(app);

  app.use(router);
  app.component('FeatherIcon', FeatherIcon);
  app.component('Badge', Badge);
  app.directive('on-outside-click', outsideClickDirective);

  // A 402 from the subscription gate on any /api/db call routes to /billing
  // (spec 0003 AC-4), even when the calling code didn't catch it.
  initSubscriptionRedirect(router);

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

/** Same handlers src/renderer.ts installs on Desktop; ipc.sendError inside
 * errorHandling is demux-guarded, so it is web-safe now (spec 0008 AC-8). */
function setErrorHandlers(app: ReturnType<typeof createApp>) {
  window.onerror = (message, source, lineno, colno, error) => {
    error = error ?? new Error('triggered in window.onerror');
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    handleError(true, error, { message, source, lineno, colno });
  };

  window.onunhandledrejection = (event: PromiseRejectionEvent) => {
    let error: Error;
    if (event.reason instanceof Error) {
      error = event.reason;
    } else {
      error = new Error(String(event.reason));
    }

    // eslint-disable-next-line no-console
    handleError(true, error).catch((err) => console.error(err));
  };

  window.addEventListener(CUSTOM_EVENTS.LOG_UNEXPECTED, (event) => {
    const details = (event as CustomEvent)?.detail as UnexpectedLogObject;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    sendError(details);
  });

  app.config.errorHandler = (err, vm, info) => {
    const more: Record<string, unknown> = {
      info,
    };

    if (vm) {
      const { fullPath, params } = vm.$route;
      more.fullPath = fullPath;
      more.params = stringifyCircular(params ?? {});
      more.props = stringifyCircular(vm.$props ?? {}, true, true);
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    handleError(false, err as Error, more);
    // eslint-disable-next-line no-console
    console.error(err, vm, info);
  };
}
