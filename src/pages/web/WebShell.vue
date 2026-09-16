<!--
  The web app shell chrome (spec 0008 AC-1, AC-5, AC-7). It is the component
  for the `/` parent route; its children (Home, ListView, CommonForm) render
  through the shared Desk.vue once the tenant is booted. Until then it shows
  a full-page loader or the status screen, so no deep link ever renders
  half-booted chrome (AC-5).

  Deliberately replicates only src/App.vue's setup() provide set (keys,
  searcher, shortcuts, languageDirection) and the toast container, NOT
  App.vue itself: App.vue is desktop-bound (DatabaseSelector, SetupWizard,
  ipc.* in its methods) and can't mount in a browser. The shared chrome that
  mounts here is Desk.vue (sidebar + router-view).

  Spec: docs/specs/0008-web-app-shell/index.md
-->
<template>
  <div class="flex flex-col flex-1 overflow-hidden" :dir="languageDirection">
    <!-- booting: full-page loader, no chrome -->
    <div
      v-if="state.kind === 'booting'"
      class="flex-1 flex items-center justify-center bg-gray-25 dark:bg-gray-900"
    >
      <div class="flex flex-col items-center gap-4">
        <svg
          class="animate-spin h-12 w-12 text-gray-600 dark:text-gray-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          ></circle>
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
        <p class="text-gray-600 dark:text-gray-400">
          {{ state.detail ?? 'Loading…' }}
        </p>
      </div>
    </div>

    <!-- unavailable: status screen with retry + sign out (AC-5) -->
    <div
      v-else-if="state.kind === 'unavailable'"
      class="flex-1 flex items-center justify-center bg-gray-25 dark:bg-gray-900 px-4"
    >
      <div
        class="max-w-md w-full bg-white dark:bg-gray-875 border border-gray-200 dark:border-gray-800 rounded-lg shadow-sm p-6 flex flex-col gap-4"
      >
        <h1 class="text-lg font-semibold text-gray-900 dark:text-gray-25">
          {{ state.canCreateOrg ? 'No organization yet' : 'Not connected' }}
        </h1>
        <p class="text-sm text-gray-600 dark:text-gray-400">
          {{ state.detail }}
        </p>
        <div class="flex gap-3">
          <button
            class="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded font-medium"
            @click="onRetry"
          >
            {{ state.canCreateOrg ? 'Create organization' : 'Retry' }}
          </button>
          <button
            class="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded"
            @click="onSignOut"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>

    <!-- ready: the shared desktop chrome -->
    <Desk v-else :dark-mode="darkMode" class="flex-1" />
  </div>
</template>
<script lang="ts">
import { RTL_LANGUAGES } from 'fyo/utils/consts';
import { defineComponent, reactive, provide, ref, type Ref } from 'vue';
import Desk from '../Desk.vue';
import * as injectionKeys from 'src/utils/injectionKeys';
import { systemLanguageRef } from 'src/utils/refs';
import { Search } from 'src/utils/search';
import { Shortcuts } from 'src/utils/shortcuts';
import { useKeys } from 'src/utils/vueUtils';
import { setDarkMode } from 'src/utils/theme';
import { fyo } from 'src/initFyo';
import {
  ensureShellReady,
  retryShellBoot,
  signOutShell,
  switchShellOrg,
} from 'src/web/shell';
import {
  shellOrganizations,
  shellBootedOrgId,
  shellState,
  shellUserEmail,
} from 'src/web/shellState';
import { webShellKey } from 'src/utils/webLive';
import router from 'src/router';

export default defineComponent({
  name: 'WebShell',
  components: { Desk },
  setup() {
    const keys = useKeys();
    const searcher: Ref<null | Search> = ref(null);
    const shortcuts = new Shortcuts(keys);
    const languageDirection = ref(
      getLanguageDirection(systemLanguageRef.value)
    );

    provide(injectionKeys.keysKey, keys);
    provide(injectionKeys.searcherKey, searcher);
    provide(injectionKeys.shortcutsKey, shortcuts);
    provide(injectionKeys.languageDirectionKey, languageDirection);
    // The Sidebar footer reads these to render the org switcher + sign out
    // on web (where desktop shows Change DB). Reactive getters keep the
    // view live as the shell boot progresses.
    provide(
      webShellKey,
      reactive({
        get organizations() {
          return shellOrganizations.value;
        },
        get bootedOrgId() {
          return shellBootedOrgId.value;
        },
        get userEmail() {
          return shellUserEmail.value;
        },
        switchOrg: switchShellOrg,
        signOut: signOutShell,
      })
    );

    return {
      keys,
      searcher,
      shortcuts,
      languageDirection,
      state: shellState,
      darkMode: ref(false),
    };
  },
  watch: {
    'state.kind'(kind: string) {
      if (kind === 'ready') {
        void this.onReady();
      }
    },
  },
  async mounted() {
    await ensureShellReady();
    if (this.state.kind === 'ready') {
      await this.onReady();
    }
  },
  methods: {
    async onReady(): Promise<void> {
      const darkMode = !!fyo.singles.SystemSettings?.darkMode;
      setDarkMode(darkMode);
      this.darkMode = darkMode;
      // Mirror App.vue.setSearcher: the injected searcher is populated
      // against the booted fyo so SearchBar works inside list/form headers.
      if (!this.searcher) {
        this.searcher = new Search(fyo);
        await this.searcher.initializeKeywords();
      }
    },
    onRetry(): void {
      if (this.state.kind === 'unavailable' && this.state.canCreateOrg) {
        void router.push('/create-organization');
        return;
      }
      retryShellBoot();
    },
    onSignOut(): void {
      signOutShell();
    },
  },
});

function getLanguageDirection(language: string): 'rtl' | 'ltr' {
  return RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
}
</script>
