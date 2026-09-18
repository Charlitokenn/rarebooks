/**
 * The web app shell's boot state (spec 0008 AC-5, AC-9) as a pure
 * module-singleton store: refs only, no Clerk/router/boot imports, no
 * side effects at module load. Sidebar.vue (shared desktop chrome) and
 * OrgSwitcher read it statically; the actor functions that mutate it live
 * in src/web/shell.ts. Keeping the read side dependency-free is what makes
 * it safe to import from anywhere in the web bundle (and, unused, from the
 * desktop bundle too).
 *
 * Spec: docs/specs/0008-web-app-shell/index.md
 */
import { computed, ref } from 'vue';
import type { ShellOrganization } from 'src/utils/webLive';

export type ShellState =
  | { kind: 'booting'; detail?: string }
  | { kind: 'ready' }
  | {
      kind: 'unavailable';
      detail: string;
      canCreateOrg?: boolean;
      /**
       * The tenant's Neon project exists but schema migration hasn't
       * completed yet (control-plane status PROJECT_CREATED) — a
       * legitimate, recoverable in-between state, not a hard failure.
       * WebShell.vue reads this to avoid the alarming "Not connected"
       * title for what is actually still-provisioning.
       */
      stillProvisioning?: boolean;
    };

const state = ref<ShellState>({ kind: 'booting' });
/** Org the current boot belongs to; null while Clerk hasn't resolved one. */
const bootedOrgId = ref<string | null>(null);
/** The user's Clerk org memberships, mirrored for the switcher. */
const organizations = ref<ShellOrganization[]>([]);
/** Clerk's primary email for the signed-in user (sidebar footer). */
const userEmail = ref('');

export const shellState = computed(() => state.value);
export const shellBootedOrgId = computed(() => bootedOrgId.value);
export const shellOrganizations = computed(() => organizations.value);
export const shellUserEmail = computed(() => userEmail.value);

/** Setters used by src/web/shell.ts only (keeps mutation in one place). */
export function setShellState(next: ShellState): void {
  state.value = next;
}

export function setShellBootedOrg(orgId: string | null): void {
  bootedOrgId.value = orgId;
}

export function setShellOrganizations(list: ShellOrganization[]): void {
  organizations.value = list;
}

export function setShellUserEmail(email: string): void {
  userEmail.value = email;
}
