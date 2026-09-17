/**
 * Maps a `boot()` result (src/web/boot.ts) to the shell state WebShell.vue
 * should show (spec 0008 AC-5). Pulled out of src/web/shell.ts as a pure
 * function, with no Clerk or router import, so the status → UI mapping can
 * be unit tested directly (tests/shellBootState.spec.ts) — src/web/shell.ts
 * itself imports the live `clerk` singleton (src/web/clerk.ts), which
 * throws at import time outside a browser with VITE_CLERK_PUBLISHABLE_KEY
 * set, so it can't be exercised from a plain mocha/tape run.
 *
 * NOT_SIGNED_IN is deliberately not handled here: it's a routing
 * side-effect (redirect to /sign-in), not a state to render, so the caller
 * (ensureShellReady) handles it before reaching this function.
 *
 * Spec: docs/specs/0008-web-app-shell/index.md
 */
import { WebFyoBoot } from 'src/web/boot';
import { ShellState } from 'src/web/shellState';

export function deriveBootShellState(boot: WebFyoBoot): ShellState {
  if (boot.status === 'READY') {
    return { kind: 'ready' };
  }

  if (boot.status === 'PROVISIONING') {
    // Still provisioning is a wait, not a dead end: keep the loader
    // (AC-5) and let the next navigation or Retry re-check.
    return {
      kind: 'booting',
      detail: 'Your account is still being set up.',
    };
  }

  if (boot.status === 'PROJECT_CREATED') {
    // The tenant's Neon project has been provisioned but the schema
    // migration hasn't completed yet — either handleOrganizationCreated's
    // synchronous migration step is still running / failed partway, or
    // the tenant is waiting on the manual
    // `npm run migrate:tenants -- --include-project-created` recovery run
    // (custom/web/db/tenantMigrationRunner.ts). This is a legitimate,
    // recoverable in-between state, the same as PROVISIONING — it must
    // not read as a hard failure the way FAILED/SUSPENDED do.
    return {
      kind: 'unavailable',
      detail:
        "We're still finishing setup on your account. This can take a " +
        'minute — try again shortly.',
      stillProvisioning: true,
    };
  }

  // FAILED, SUSPENDED, and UNKNOWN fall through here as genuine dead ends.
  return {
    kind: 'unavailable',
    detail:
      boot.status === 'FAILED'
        ? boot.error ?? 'Could not reach your data.'
        : `Your account is not ready yet (status: ${boot.status}).`,
  };
}
