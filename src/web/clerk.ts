/**
 * @clerk/clerk-js bundled directly, replacing @clerk/vue's clerkPlugin.
 *
 * @clerk/vue (and @clerk/react, etc.) don't bundle clerk-js themselves —
 * they lazy-load it from Clerk's CDN at runtime via @clerk/shared's
 * loadClerkJsScript, specifically to keep the framework wrapper's own
 * bundle size small. That CDN load was failing in this app with
 * "Missing publishableKey" thrown from inside the freshly-loaded script,
 * despite the key being provably correct at every layer on our side
 * (traced through @clerk/vue's and @clerk/shared's actual source,
 * confirmed byte-for-byte correct in a real production build) — a bug
 * inside that lazy-loading mechanism itself, not fixable from here.
 *
 * Bundling @clerk/clerk-js directly, as a normal import, skips that
 * mechanism entirely: there is no dynamic <script> tag, no CDN fetch, no
 * loadClerkJsScript in this code path at all.
 *
 * @clerk/clerk-js's own UI rendering (the actual sign-in/sign-up forms)
 * is ALSO not bundled into clerk-js itself — by default it's lazy-loaded
 * from Clerk's CDN too, the same mechanism we're avoiding. @clerk/ui is
 * the officially documented way to bundle it directly instead (see the
 * doc comment on ClerkOptions.ui in @clerk/shared's types: "Only required
 * if you're bundling Clerk's UI (@clerk/ui) instead of loading it from
 * the Clerk CDN"). Passed into clerk.load() below.
 *
 * Note: @clerk/ui's main entry exports `ui`, a plain object meant for
 * @clerk/react's <ClerkProvider ui={ui}> — passing that value here as
 * ClerkUI crashes at runtime ("X is not a constructor"), since
 * clerk.load() actually instantiates whatever it's given with `new`.
 * The real constructor class is `ClerkUI`, exported from the separate
 * @clerk/ui/entry subpath.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md (AC-6)
 */
import { Clerk } from '@clerk/clerk-js';
import { ClerkUI } from '@clerk/ui/entry';
import { ref, onUnmounted, type Ref } from 'vue';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

if (!PUBLISHABLE_KEY) {
  throw new Error(
    'VITE_CLERK_PUBLISHABLE_KEY is not set — required for the Web target (see worker/wrangler.toml for the matching CLERK_PUBLISHABLE_KEY Worker secret)'
  );
}

export const clerk = new Clerk(PUBLISHABLE_KEY);

/**
 * Matches the shape clerk.addListener()'s callback receives (@clerk/shared's
 * internal `Resources` type, not part of @clerk/clerk-js's public exports).
 * Derived via typeof from clerk's own instance properties rather than
 * importing type names that aren't exported from @clerk/clerk-js's index.
 */
interface ClerkEmission {
  client: NonNullable<typeof clerk.client>;
  session?: typeof clerk.session;
  user?: typeof clerk.user;
  organization?: typeof clerk.organization;
}

let loadPromise: Promise<void> | undefined;

/** Call once, before mounting the app. Idempotent. */
export function initClerk(): Promise<void> {
  loadPromise ??= clerk.load({
    ui: { ClerkUI },
    taskUrls: {
      'choose-organization': '/session-tasks/choose-organization',
      // add others you actually use, e.g.:
      // 'reset-password': '/session-tasks/reset-password',
      // 'setup-mfa': '/session-tasks/setup-mfa',
    },
  });
  return loadPromise;
}

export interface ClerkAuthState {
  isLoaded: Ref<boolean>;
  isSignedIn: Ref<boolean>;
  orgId: Ref<string | undefined>;
  userId: Ref<string | undefined>;
}

/**
 * Reactive auth state, wrapping clerk.addListener() in Vue refs. Mirrors
 * the shape of @clerk/vue's useAuth() (isLoaded, isSignedIn, orgId,
 * userId) closely enough that the pages built against useAuth() needed
 * no logic changes, only the import swapped.
 */
export function useClerkAuth(): ClerkAuthState {
  const isLoaded = ref(false);
  const isSignedIn = ref(false);
  const orgId = ref<string | undefined>(undefined);
  const userId = ref<string | undefined>(undefined);

  function apply(emission: ClerkEmission) {
    isLoaded.value = true;
    isSignedIn.value = !!emission.session;
    orgId.value = emission.organization?.id;
    userId.value = emission.user?.id;
  }

  // clerk.load() (called once via initClerk()) resolves after the first
  // emission has already fired, so read current state immediately rather
  // than waiting for the next change.
  apply({
    client: clerk.client!,
    session: clerk.session,
    user: clerk.user,
    organization: clerk.organization,
  });

  const unsubscribe = clerk.addListener(apply);
  onUnmounted(unsubscribe);

  return { isLoaded, isSignedIn, orgId, userId };
}
