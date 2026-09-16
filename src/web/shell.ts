/**
 * The web app shell's boot actor (spec 0008): drives the state in
 * src/web/shellState.ts from Clerk's session transitions and
 * src/web/boot.ts's tenant connect. WebShell.vue awaits ensureShellReady()
 * when it mounts and on loader Retry, so direct opens and reloads of deep
 * links gate on boot too (AC-5: the chrome renders only in `ready`).
 *
 * An organization switch or sign-out bumps the boot epoch
 * (utils/db/bootEpoch) BEFORE anything else, which fyo/demux/db.ts checks
 * around every tenant fetch, so a response from the old org can never land
 * in the new boot (AC-9).
 *
 * Spec: docs/specs/0008-web-app-shell/index.md
 */
import { SubscriptionInactiveError } from 'fyo/utils/errors';
import { ensureWebFyoReady } from 'src/web/boot';
import { clerk } from 'src/web/clerk';
import {
  setShellBootedOrg,
  setShellOrganizations,
  setShellState,
  setShellUserEmail,
  shellBootedOrgId,
  shellState,
} from 'src/web/shellState';
import { handleSubscriptionError } from 'src/web/subscription';
import router from 'src/router';
import { bumpBootEpoch } from 'utils/db/bootEpoch';

interface BootInFlight {
  orgId: string;
  promise: Promise<void>;
}

let bootInFlight: BootInFlight | null = null;

function isActiveBoot(orgId: string, promise: Promise<void>): boolean {
  return (
    bootInFlight?.orgId === orgId &&
    bootInFlight.promise === promise &&
    shellBootedOrgId.value === orgId &&
    clerk.session !== null &&
    clerk.organization?.id === orgId
  );
}

/**
 * Boot (or re-attempt) the shell for the Clerk active organization. The
 * result is cached per org: a second call while ready is a no-op, while
 * any non-ready state re-runs the boot. Concurrent callers share one run.
 */
export function ensureShellReady(): Promise<void> {
  if (!clerk.session) {
    bootInFlight = null;
    setShellBootedOrg(null);
    setShellState({
      kind: 'unavailable',
      detail: 'Please sign in to continue.',
    });
    return Promise.resolve();
  }

  const orgId = clerk.organization?.id ?? null;

  if (!orgId) {
    bootInFlight = null;
    setShellBootedOrg(null);
    setShellState({
      kind: 'unavailable',
      detail: 'No organization is active yet. Create one to get started.',
      canCreateOrg: true,
    });
    return Promise.resolve();
  }

  if (shellState.value.kind === 'ready' && shellBootedOrgId.value === orgId) {
    return Promise.resolve();
  }

  if (bootInFlight?.orgId === orgId) {
    return bootInFlight.promise;
  }

  setShellBootedOrg(orgId);
  setShellState({ kind: 'booting' });
  const requested = orgId;

  const currentPromise = Promise.resolve().then(async () => {
    try {
      const boot = await ensureWebFyoReady(requested);
      // Clerk moved on (sign-out or a quick second switch) while we were
      // connecting: that transition owns the state now.
      if (!isActiveBoot(requested, currentPromise)) {
        return;
      }

      if (boot.status === 'READY') {
        setShellState({ kind: 'ready' });
      } else if (boot.status === 'PROVISIONING') {
        // Still provisioning is a wait, not a dead end: keep the loader
        // (AC-5) and let the next navigation or Retry re-check.
        setShellState({
          kind: 'booting',
          detail: 'Your account is still being set up.',
        });
      } else if (boot.status === 'NOT_SIGNED_IN') {
        void router.replace('/sign-in');
      } else {
        setShellState({
          kind: 'unavailable',
          detail:
            boot.status === 'FAILED'
              ? boot.error ?? 'Could not reach your data.'
              : `Your account is not ready yet (status: ${boot.status}).`,
        });
      }
    } catch (err) {
      if (!isActiveBoot(requested, currentPromise)) {
        return;
      }

      if (err instanceof SubscriptionInactiveError) {
        // A 402 while connecting (e.g. the subscription was cancelled):
        // route to /billing through the same handler the global net uses
        // (spec 0003 AC-4), not the generic unavailable screen (AC-6).
        if (!handleSubscriptionError(err, router)) {
          setShellState({
            kind: 'unavailable',
            detail: 'Your subscription is inactive.',
          });
        }
        return;
      }
      setShellState({
        kind: 'unavailable',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (bootInFlight?.promise === currentPromise) {
        bootInFlight = null;
      }
    }
  });

  bootInFlight = { orgId: requested, promise: currentPromise };

  return currentPromise;
}

/** Loader "Retry": re-enter boot for the current Clerk state. */
export function retryShellBoot(): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  ensureShellReady();
}

/**
 * Sign out (AC-1, AC-5): the session ends; Clerk's listener (installed by
 * initShellAuth) bumps the epoch and routes to /sign-in.
 */
export function signOutShell(): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  clerk.signOut({ redirectUrl: '/sign-in' });
}

/** Switch the active organization (AC-9); the listener completes the reboot. */
export function switchShellOrg(orgId: string): void {
  if (orgId === clerk.organization?.id) {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  clerk.setActive({ organization: orgId });
}

let authWired = false;

/**
 * Mirror Clerk's session transitions into the shell state. Called once at
 * boot (rendererWeb.ts). The epoch is bumped BEFORE anything else on a
 * transition so every tenant fetch already in flight is doomed to be
 * discarded, whichever change follows (switch or sign-out).
 */
export function initShellAuth(): void {
  if (authWired) {
    return;
  }
  authWired = true;

  const apply = () => {
    setShellOrganizations(
      (clerk.user?.organizationMemberships ?? [])
        .map((m) => ({ id: m.organization.id, name: m.organization.name }))
        .filter((org) => org.id)
    );
    setShellUserEmail(clerk.user?.primaryEmailAddress?.emailAddress ?? '');

    const orgId = clerk.organization?.id ?? null;

    if (!clerk.session) {
      bumpBootEpoch();
      bootInFlight = null;
      setShellBootedOrg(null);
      setShellState({ kind: 'booting', detail: 'Redirecting to sign in…' });
      if (router.currentRoute.value.meta.shell) {
        void router.replace('/sign-in');
      }
      return;
    }

    if (orgId !== shellBootedOrgId.value) {
      bumpBootEpoch();
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      ensureShellReady();
    }
  };

  apply();
  clerk.addListener(apply);
}
