import { clerkPlugin } from '@clerk/vue';
import { App as VueApp, createApp } from 'vue';
import AuthGate from './AuthGate.vue';
import Badge from './components/Badge.vue';
import FeatherIcon from './components/FeatherIcon.vue';
import { handleError, sendError } from './errorHandling';
import { fyo } from './initFyo';
import { outsideClickDirective } from './renderer/helpers';
import router from './router';
import { stringifyCircular } from './utils';
import { setLanguageMap } from './utils/language';
import { CUSTOM_EVENTS } from 'utils/messages';
import { UnexpectedLogObject } from 'utils/types';

// The web counterpart to src/renderer.ts. Deliberately does NOT reuse renderer.ts as-is:
// that file calls `await ipc.getEnv()` unconditionally as one of its first lines, and
// `registerIpcRendererListeners()` right before it - both hard Electron dependencies that
// would throw immediately on load here, since window.ipc doesn't exist in a browser tab.
//
// Everything else IS replicated deliberately, not dropped - the global mixin
// (this.fyo/this.t/this.T/this.platform), Vue Router, global component registrations
// (FeatherIcon/Badge), the outside-click directive, and the window-level error handlers are
// all things the rest of the app (router.ts, Desk.vue, and presumably most pages under it)
// depend on implicitly, not just App.vue. Missing any of these would break far more than
// this file - found that out the hard way checking renderer.ts's mixin setup before
// shipping this.
(async () => {
  const language = fyo.config.get('language') as string;
  if (language) {
    await setLanguageMap(language);
  }
  fyo.store.language = language || 'English';

  // No registerIpcRendererListeners() - those are all Electron IPC event subscriptions
  // with no web equivalent (yet - see Phase 5 of the migration plan for what each one maps
  // to as those features get ported).
  fyo.store.isDevelopment = import.meta.env.DEV;
  fyo.store.appVersion = 'web';
  fyo.store.platform = 'web';

  const app = createApp({
    template: '<AuthGate/>',
  });
  app.config.unwrapInjectedRef = true;
  setErrorHandlers(app);

  app.use(router);
  app.use(clerkPlugin, {
    publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string,
  });
  app.component('AuthGate', AuthGate);
  app.component('FeatherIcon', FeatherIcon);
  app.component('Badge', Badge);
  app.directive('on-outside-click', outsideClickDirective);
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

  await fyo.telemetry.logOpened();
  app.mount('body');
})();

function setErrorHandlers(app: VueApp) {
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
