/**
 * Web-side boot of the shared `fyo`, against the signed-in org's tenant
 * database. This is the browser equivalent of what src/App.vue does on
 * Desktop via src/utils/initialization.ts's initializeInstance() —
 * connect, then initializeAndRegister() — minus everything that only
 * makes sense on a single machine: no config file, no openCount, no
 * deviceId/instanceId (Electron's `fyo.config` is an in-memory Map on
 * Web, fyo/demux/config.ts), no migrateExpenseTable (a Desktop data
 * repair), and no regional models (only 'in' has any, models/index.ts;
 * the hosted tenant's country has no bearing on what can be imported).
 *
 * Deliberately NOT reused: src/utils/initialization.ts itself. Every
 * step of it reads or writes Electron-only state (`fyo.config`,
 * `fyo.db.dbPath` semantics for the config files list), and importing it
 * would pull that assumption in wholesale. The one piece of real shared
 * logic worth matching is the singles load: initializeInstance's
 * setSingles() calls `fyo.doc.getDoc(schema.name)` for every Single,
 * which populates `fyo.singles`. Here we load only the Singles the Web
 * surface actually needs (see loadNotificationSingles) rather than all
 * ~25, because each getDoc on Web is a fetch round trip.
 *
 * Connecting order matters: fyo.db.connectToDatabase('web') fetches the
 * tenant's full schemaMap from GET /api/db/schema (fyo/demux/db.ts), so
 * it must only run when the tenant is actually READY — on any other
 * status the worker rejects the schema call and the boot would surface
 * as a scary DatabaseError instead of the honest "still provisioning".
 * That's also why Dashboard.vue checks readiness by direct fetch before
 * this existed; the same reasoning is on its docblock.
 *
 * The dbPath argument is a placeholder the DatabaseHandler stores to mark
 * the connection live (`isConnected = !!dbPath`); unlike Desktop there is
 * no path on disk, and nothing on the Web branch reads it back.
 *
 * Used by spec 0006 (web notifications) for the Settings surface; future
 * Web features that need the model layer (Docs, forms) should boot
 * through here instead of reinventing the sequence.
 */
import type { Fyo } from 'fyo';
import { models } from 'models/index';
import { ModelNameEnum } from 'models/types';
import { fyo } from 'src/initFyoWeb';

export type WebFyoStatus =
  | 'READY'
  | 'PROVISIONING'
  | 'PROJECT_CREATED'
  | 'NOT_SIGNED_IN'
  | 'UNKNOWN'
  | 'FAILED';

export interface WebFyoBoot {
  fyo: Fyo;
  status: WebFyoStatus;
  /** Error message when status is 'FAILED'. */
  error?: string;
}

const WEB_DB_PATH = 'web';

/**
 * Singles the Web renderer needs present in `fyo.singles` before the
 * Settings surface can edit them (spec 0006 AC-2). POSSettings carries
 * enableMobileNotifications/messageChannel; InventorySettings carries
 * enablePointOfSale, which is what gates the POS tab's visibility on
 * Desktop (src/pages/Settings/Settings.vue) and which a tenant may well
 * not have touched, so it must load for the tab logic to decide at all.
 */
async function loadNotificationSingles(fyo: Fyo): Promise<void> {
  for (const schemaName of [
    ModelNameEnum.InventorySettings,
    ModelNameEnum.POSSettings,
  ]) {
    // getDoc caches into fyo.singles (DocHandler.getDoc → singles map).
    await fyo.doc.getDoc(schemaName);
  }
}

async function boot(): Promise<WebFyoBoot> {
  // Honest pre-check (see header comment): /api/dashboard's status decides
  // whether the schema fetch below can be expected to succeed. A
  // non-READY tenant is a valid, retryable state, not an error.
  let tenantStatus = 'UNKNOWN';
  try {
    const res = await fetch('/api/dashboard', { credentials: 'include' });
    if (res.status === 401) {
      return { fyo, status: 'NOT_SIGNED_IN' };
    }
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    tenantStatus = body.status ?? 'UNKNOWN';
  } catch (err) {
    return {
      fyo,
      status: 'FAILED',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (tenantStatus !== 'READY') {
    return { fyo, status: tenantStatus as WebFyoStatus };
  }

  try {
    // demux web branch: POST /api/db/schema, then fieldMap build
    // (fyo/core/dbHandler.ts init()).
    if (!fyo.db.isConnected) {
      await fyo.db.connectToDatabase(WEB_DB_PATH);
    }
    // Same call Desktop's initializeInstance makes: registers every model,
    // reads SystemSettings singles for money precision. Idempotent via
    // fyo._initialized.
    await fyo.initializeAndRegister(models, {});
    await loadNotificationSingles(fyo);
  } catch (err) {
    // A failure here leaves fyo half-booted (schema connected but singles
    // missing, or vice versa). The caller treats it as FAILED and retries;
    // retry is safe because connectToDatabase and initializeAndRegister
    // are both guarded above, and a fresh getDoc re-reads.
    return {
      fyo,
      status: 'FAILED',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { fyo, status: 'READY' };
}

let inFlight: Promise<WebFyoBoot> | null = null;

/**
 * Boots the web fyo against the tenant database, once. Concurrent callers
 * (Dashboard and Settings mounting near-simultaneously, a remount after a
 * Clerk transition) share one in-flight boot instead of racing two schema
 * fetches. Only a READY result is cached: any other status stays
 * retryable, so a Retry click or a sign-in transition re-runs the boot
 * instead of being served the stale answer.
 */
export function ensureWebFyoReady(): Promise<WebFyoBoot> {
  if (inFlight === null) {
    inFlight = boot().then((result) => {
      if (result.status !== 'READY') {
        inFlight = null;
      }
      return result;
    });
  }
  return inFlight;
}
