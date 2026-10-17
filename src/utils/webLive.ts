/**
 * Which sidebar routes are actually reachable on the Web shell (spec 0008
 * AC-10), and the injection contract the web shell hands the shared
 * Sidebar.vue. Kept free of Clerk/boot imports on purpose: Sidebar.vue is
 * part of the shared desktop chrome, so anything it imports must stay safe
 * to evaluate in the desktop bundle. Desktop never consults any of this
 * (the callers guard on fyo.isElectron / the injected value being null);
 * the implementations live in src/web/.
 */
import type { InjectionKey } from 'vue';
import type { QueryFilter } from 'utils/db/types';

export const WEB_LIVE_ROUTES = [
  '/',
  '/list/Party',
  '/edit/Party',
  '/settings',
  '/billing',
];

export function isWebRouteLive(routePath: string): boolean {
  return WEB_LIVE_ROUTES.some(
    (live) => routePath === live || routePath.startsWith(live + '/')
  );
}

export interface ShellOrganization {
  id: string;
  name: string;
}

/**
 * Web shell actions the Sidebar footer renders (org switcher + sign out)
 * in place of desktop's Change DB (spec 0008 AC-1, AC-9). Provided only by
 * WebShell.vue; injecting yields null everywhere else (Desktop, and web
 * pages outside the shell like /billing).
 */
export interface WebShellActions {
  organizations: ShellOrganization[];
  bootedOrgId: string | null;
  userEmail: string;
  switchOrg(orgId: string): void;
  signOut(): void;
}

export const webShellKey: InjectionKey<WebShellActions | null> =
  Symbol('webShell');

export interface SidebarTarget {
  route: string;
  items?: SidebarTarget[];
  filters?: QueryFilter;
}

/**
 * What a sidebar click resolves to on Web: the entry itself when its route
 * is live, otherwise its first live descendant (the Customers item under
 * the Sales group), otherwise null, which is what renders the entry
 * disabled/coming-soon.
 */
export function webSidebarTarget(entry: SidebarTarget): SidebarTarget | null {
  if (isWebRouteLive(entry.route)) {
    return entry;
  }

  for (const item of entry.items ?? []) {
    if (webSidebarTarget(item) !== null) {
      return item;
    }
  }

  return null;
}
