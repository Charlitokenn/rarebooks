/**
 * Web router. This file is what the `src/router` specifier resolves to in
 * the web bundle (alias in vite.config.web.ts), so the desktop chrome's
 * `import router from 'src/router'` consumers (src/utils/ui.ts,
 * src/errorHandling.ts, Sidebar.vue) get the web route set with no edits
 * (spec 0008 AC-7). Deliberately not src/router.ts: that one eagerly
 * imports all 16 desktop pages and carries an Electron license guard
 * (window.ipc.invoke), neither of which belongs in the browser.
 *
 * The chrome (sidebar, list, form) is mounted under a single parent route
 * whose component (WebShell) owns the boot state machine and renders Desk
 * only once the tenant is ready, so opening or reloading any deep link
 * under it (e.g. /list/Party/Customers) gates on boot too (AC-5). List and
 * form routes mirror the desktop route shapes so the shared components and
 * src/utils/ui.ts navigation work unmodified.
 *
 * Specs: docs/specs/0001-web-platform-foundation-control-plane.md
 * (sign-in/billing pages), docs/specs/0008-web-app-shell/index.md (the shell).
 */
import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from 'vue-router';
import { historyState } from 'src/utils/refs';
import SignIn from 'src/pages/web/SignIn.vue';
import SignUp from 'src/pages/web/SignUp.vue';
import CreateOrganization from 'src/pages/web/CreateOrganization.vue';
import Billing from 'src/pages/web/Billing.vue';
import Settings from 'src/pages/web/Settings.vue';

// The desktop list/form components mount shared, booted-fyo chrome; lazy
// so a non-booted first paint never pulls them into the critical chunk.
const WebShell = () => import('src/pages/web/WebShell.vue');
const ShellHome = () => import('src/pages/web/ShellHome.vue');
const ListView = () => import('src/pages/ListView/ListView.vue');
const QuickEditForm = () => import('src/pages/QuickEditForm.vue');
const CommonForm = () => import('src/pages/CommonForm/CommonForm.vue');

function parseRouteFilters(filterString: unknown): Record<string, unknown> {
  if (typeof filterString !== 'string') {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(filterString);
    if (parsed === null || typeof parsed !== 'object') {
      return {};
    }

    return { ...(parsed as Record<string, unknown>) };
  } catch {
    return {};
  }
}

const SetupWizard = () => import('src/pages/web/SetupWizard.vue');

const routes: RouteRecordRaw[] = [
  // Auth + standalone pages, outside the shell (kept from feature 0001).
  { path: '/sign-in/:pathMatch(.*)*', component: SignIn },
  { path: '/sign-up/:pathMatch(.*)*', component: SignUp },
  { path: '/create-organization', component: CreateOrganization },
  { path: '/setup', component: SetupWizard },
  { path: '/billing', component: Billing },
  { path: '/settings', component: Settings },

  // The app shell: a booted tenant's real desktop chrome. `/dashboard`
  // (the old standalone landing) now redirects here, replaced not kept
  // beside it (AC-1).
  { path: '/dashboard', redirect: '/' },
  {
    path: '/',
    component: WebShell,
    meta: { shell: true },
    children: [
      { path: '', name: 'Home', component: ShellHome },
      {
        path: '/list/:schemaName/:pageTitle?',
        name: 'ListView',
        components: { default: ListView, edit: QuickEditForm },
        props: {
          default: (route) => {
            const { schemaName } = route.params;
            const pageTitle = route.params.pageTitle ?? '';

            const filters = parseRouteFilters(route.query.filters);

            return {
              schemaName,
              filters,
              pageTitle,
            };
          },
          edit: (route) => route.query,
        },
      },
      {
        path: '/edit/:schemaName/:name',
        name: 'CommonForm',
        components: { default: CommonForm, edit: QuickEditForm },
        props: {
          default: (route) => ({
            schemaName: route.params.schemaName,
            name: route.params.name,
          }),
          edit: (route) => route.query,
        },
      },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Mirrors the harmless localStorage last-route bookkeeping the desktop
// router does; no Electron, no license guard.
router.afterEach(({ fullPath }) => {
  const state = history.state as { forward?: boolean; back?: boolean };
  historyState.forward = !!state.forward;
  historyState.back = !!state.back;

  if (fullPath.includes('index.html')) {
    return;
  }

  try {
    localStorage.setItem('lastRoute', fullPath);
  } catch {
    // Private mode / disabled storage: routing still works without it.
  }
});

export default router;
