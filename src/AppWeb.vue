<template>
  <div
    id="app"
    class="
      dark:bg-gray-900
      h-screen
      flex flex-col
      font-sans
      overflow-hidden
      antialiased
    "
    :dir="languageDirection"
    :language="language"
  >
    <!-- No WindowsTitleBar - there's no window chrome to draw in a browser tab -->

    <Desk
      v-if="activeScreen === 'Desk'"
      class="flex-1"
      :dark-mode="darkMode"
      @change-db-file="switchOrganization"
    />
    <SetupWizard
      v-if="activeScreen === 'SetupWizard'"
      @setup-complete="setupComplete"
      @setup-canceled="switchOrganization"
    />

    <div
      v-if="activeScreen === null"
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
        <p class="text-gray-600 dark:text-gray-400">{{ loadingMessage }}</p>
      </div>
    </div>

    <div
      id="toast-container"
      class="absolute bottom-0 flex flex-col items-end mb-3 pe-6"
      style="width: 100%; pointer-events: none"
    ></div>
  </div>
</template>
<script lang="ts">
/**
 * Web adaptation of src/App.vue. Kept as a separate file rather than editing App.vue in
 * place, matching the same parallel-file pattern as rendererWeb.ts - the Electron build's
 * App.vue is untouched. Uses the same unified src/initFyo.ts as the Electron build (it
 * auto-detects Electron vs web at runtime - see that file).
 *
 * Mounted by AuthGate.vue once Clerk reports isSignedIn + an active orgId - there is no
 * DatabaseSelector screen on web at all (see the chat discussion of
 * custom/src/pages/DatabaseSelectorCustom.vue: it's 100% local-file-picker UX with nothing
 * worth porting). Clerk's <SignIn>/<OrganizationSwitcher> in AuthGate already cover that
 * role. "dbPath" throughout this file is the literal string 'web' - a placeholder,
 * meaningless to DatabaseDemuxWeb, kept only because several existing utility functions
 * (connectToDatabase, initializeInstance, setupInstance) take a dbPath argument.
 *
 * Every ipc.* call from the original App.vue was checked individually - see inline
 * comments below for what happened to each one.
 */
import { RTL_LANGUAGES } from 'fyo/utils/consts';
import { ModelNameEnum } from 'models/types';
import { systemLanguageRef } from 'src/utils/refs';
import { defineComponent, provide, ref, Ref } from 'vue';
import { handleErrorWithDialog } from './errorHandling';
import { fyo } from './initFyo';
import Desk from './pages/Desk.vue';
import SetupWizard from './pages/SetupWizard/SetupWizard.vue';
// Base setupInstance, NOT custom/setup/setupInstanceCustom - that wrapper's
// createDefaultSuperAdmin() calls ipc.hashPassword(), a direct Electron IPC call that would
// throw on web. It's also arguably redundant now: createDefaultSuperAdmin creates a local
// password-based "super admin" User doc, but Clerk already owns identity for the web app -
// whoever just created this org via Clerk IS the admin. Worth confirming with Charles
// whether that local-user concept should exist at all going forward, rather than silently
// deciding either way here.
import setupInstance from './setup/setupInstance';
import { SetupWizardOptions } from './setup/types';
import './styles/index.css';
import { connectToDatabase, dbErrorActionSymbols } from './utils/db';
import { initializeInstance } from './utils/initialization';
import * as injectionKeys from './utils/injectionKeys';
import { showToast } from './utils/interactive';
import { setLanguageMap } from './utils/language';
import { updateConfigFiles } from './utils/misc';
import { Search } from './utils/search';
import { Shortcuts } from './utils/shortcuts';
import { routeTo } from './utils/ui';
import { useKeys } from './utils/vueUtils';
import { setDarkMode } from 'src/utils/theme';

const WEB_DB_PATH = 'web';

enum Screen {
  Desk = 'Desk',
  SetupWizard = 'SetupWizard',
}

export default defineComponent({
  name: 'AppWeb',
  components: {
    Desk,
    SetupWizard,
  },
  emits: ['switch-organization'],
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

    return { keys, searcher, shortcuts, languageDirection };
  },
  data() {
    return {
      activeScreen: null,
      dbPath: WEB_DB_PATH,
      companyName: '',
      darkMode: false,
      loadingMessage: 'Loading...',
    } as {
      activeScreen: null | Screen;
      dbPath: string;
      companyName: string;
      darkMode: boolean | undefined;
      loadingMessage: string;
    };
  },
  computed: {
    language(): string {
      return systemLanguageRef.value;
    },
  },
  watch: {
    language(value: string) {
      this.languageDirection = getLanguageDirection(value);
    },
  },
  async mounted() {
    // Original App.vue's setInitialScreen() read fyo.config's lastSelectedFilePath to
    // decide whether to show DatabaseSelector or resume a session. On web that decision is
    // already made by the time this component even mounts - AuthGate only renders <AppWeb>
    // once Clerk reports an active orgId, which is the web equivalent of "a company is
    // selected". So this always goes straight to the connect-or-setup flow.
    try {
      await this.showSetupWizardOrDesk();
    } catch (error) {
      await handleErrorWithDialog(error, undefined, true, true);
    }
  },
  methods: {
    async setSearcher(): Promise<void> {
      this.searcher = new Search(fyo);
      await this.searcher.initializeKeywords();
    },
    async setDesk(): Promise<void> {
      await setLanguageMap();
      this.activeScreen = Screen.Desk;
      await this.setDeskRoute();
      await fyo.telemetry.start(true);
      // ipc.checkForUpdates() dropped entirely - there's no auto-update concept for a web
      // app, it always serves the latest deploy.
      this.companyName = (await fyo.getValue(
        ModelNameEnum.AccountingSettings,
        'companyName'
      )) as string;
      await this.setSearcher();
      // updateConfigFiles reads/writes fyo.config only (safe - in-memory Map on web, see
      // fyo/demux/config.ts) and fyo.db.dbPath (just stores whatever string was passed to
      // connectToDatabase/createNewDatabase - 'web' here). No Electron dependency.
      updateConfigFiles(fyo);
    },
    async showSetupWizardOrDesk(): Promise<void> {
      const { countryCode, error, actionSymbol } = await connectToDatabase(
        this.fyo,
        WEB_DB_PATH
      );

      if (!countryCode && error && actionSymbol) {
        return await this.handleConnectionFailed(error);
      }

      const setupComplete = await fyo.getValue(
        ModelNameEnum.AccountingSettings,
        'setupComplete'
      );

      if (!setupComplete) {
        this.activeScreen = Screen.SetupWizard;
        return;
      }

      await initializeInstance(WEB_DB_PATH, false, countryCode, fyo);

      // updatePrintTemplates(fyo) dropped - it calls ipc.getTemplates() to read
      // templates/*.html from local disk. This is a real, not-yet-solved Phase 5 gap
      // (bundle templates into the frontend build instead) rather than something this
      // pass can responsibly paper over - printing/PDF generation will need that work
      // before it functions on web.

      // ERPNext sync: registerInstanceToERPNext/updateERPNSyncSettings don't call ipc.*
      // directly (confirmed) so left in place, but the whole block is gated on
      // enableERPNextSync being true, which won't be the case for a fresh web org. The one
      // real gap inside it: ipc.initScheduler() (a main-process cron job) has no web
      // equivalent yet - if/when ERPNext sync is actually used on web, that becomes a
      // Cloudflare Worker Cron Trigger on rarebooks-api, not something to fake here.
      const enableERPNextSync = fyo.singles.AccountingSettings?.enableERPNextSync;
      if (enableERPNextSync) {
        showToast({
          message: 'ERPNext sync is enabled but not yet supported on the web app.',
          type: 'warning',
        });
      }

      await this.setDesk();
    },
    async setupComplete(setupWizardOptions: SetupWizardOptions): Promise<void> {
      // ipc.getDbDefaultPath(companyName) dropped - no file path to generate on web.
      await setupInstance(WEB_DB_PATH, setupWizardOptions, fyo);
      await connectToDatabase(this.fyo, WEB_DB_PATH);

      showToast({
        message: 'Organization set up successfully.',
        type: 'success',
        duration: 5000,
      });

      await this.setDesk();
    },
    async handleConnectionFailed(error: Error) {
      // The original handleConnectionFailed also branched on
      // dbErrorActionSymbols.SelectFile to call databaseSelector.existingDatabase() - no
      // equivalent exists on web (no DatabaseSelector), and in practice that branch can't
      // be reached here anyway: connectToDatabase's error matching (src/utils/db.ts) only
      // recognizes SQLite-specific error strings ('directory does not exist', 'Unable to
      // acquire a connection'), neither of which a Worker/HTTP error will ever produce -
      // any real web error falls through to the throw below instead.
      this.$emit('switch-organization');

      if (
        error &&
        typeof (error as { message?: string }).message === 'string'
      ) {
        throw error;
      }
    },
    async setDeskRoute(): Promise<void> {
      const { onboardingComplete } = await fyo.doc.getDoc('GetStarted');
      const { hideGetStarted } = await fyo.doc.getDoc('SystemSettings');

      let route = '/get-started';
      if (hideGetStarted || onboardingComplete) {
        route = localStorage.getItem('lastRoute') || '/';
      }

      await routeTo(route);
    },
    // Replaces showDbSelector() - there's no local DatabaseSelector screen to return to on
    // web. Instead, tell AuthGate to show Clerk's <OrganizationSwitcher> again so the user
    // can pick a different organization.
    async switchOrganization(): Promise<void> {
      localStorage.clear();
      fyo.telemetry.stop();
      await fyo.purgeCache();
      this.activeScreen = null;
      this.companyName = '';
      this.searcher = null;
      this.$emit('switch-organization');
    },
  },
});

function getLanguageDirection(language: string): 'rtl' | 'ltr' {
  return RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
}
</script>
