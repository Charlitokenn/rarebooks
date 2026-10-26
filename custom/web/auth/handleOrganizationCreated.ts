/**
 * The provisioning queue consumer: takes `{ orgId }` off the provisioning
 * queue and drives that org's tenant row to READY, with exactly one Neon
 * project named `rarebooks-tenant-<orgId>`. The `organization.created`
 * webhook (worker/routes/webhooks/organization-created.ts) only records the
 * org and enqueues; everything slow happens here, outside the webhook's
 * timeout, with the queue's own retries behind it.
 *
 * Every attempt claims the row with a 20 minute lease keyed by the queue
 * message id, and every write after the claim is fenced by that id, so a
 * run whose lease was taken over changes nothing. Before creating a project
 * it reuses the one recorded on the row, or adopts one Neon already has by
 * name, so a crash between "Neon created it" and "we recorded it" never
 * leaves a second, billed project behind. Anything that still slips through
 * goes in the orphan ledger for `npm run reconcile:tenants`.
 *
 * Reads nothing from Clerk. Never import custom/licensing/ (Keymint) from
 * this file or anything it calls — the web target has no device-bound
 * licensing.
 *
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md (consumer
 * algorithm, dead letter consumer, AC-2 to AC-7, AC-12)
 * Amends: docs/specs/0001-web-platform-foundation-control-plane.md (AC-2)
 */
import {
  claimProvisioningLease,
  type ControlDb,
  ensureTenantProjectRow,
  failDeadLetteredTenantProject,
  getProvisioningState,
  insertNeonProjectOrphan,
  markTenantProjectReady,
  recordProvisioningFailure,
  recordTenantProject,
} from '../../../worker/db/control';
import { decrypt, encrypt } from '../../../worker/lib/encryption';
import { applyTenantSchema } from './applyTenantSchema';

/** The whole queue message body. Never a connection string. */
export interface ProvisioningMessageBody {
  orgId: string;
}

/**
 * The slice of a Cloudflare Queues `Message` this file uses. Declared here
 * rather than imported because custom/web/ also compiles under the root
 * tsconfig, which has no Workers types; the real `Message` fits it.
 */
export interface ProvisioningMessage {
  readonly id: string;
  /** 1 based; a crash uses up a delivery too. */
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface NeonProjectSummary {
  id: string;
  createdAt: string;
  region: string;
}

export interface NeonProvisioningClient {
  /** Wraps @neon/sdk's neon.projects.createAndConnect(). The Neon account
   * org (NEON_ACCOUNT_ORG_ID) is configured once at client construction
   * (worker/lib/neon-client.ts), not passed per call — it is NOT the
   * tenant's Clerk org. */
  createAndConnect(params: { name: string }): Promise<{
    neonProjectId: string;
    connectionString: string;
    region: string;
  }>;
  /** Every project named exactly `name`, across every page, oldest first. */
  findProjectsByName(name: string): Promise<NeonProjectSummary[]>;
  /** Connection string for an adopted project's single database. Throws
   * ProvisioningNotReadyError while the project can't be used yet. */
  getConnectionString(projectId: string): Promise<string>;
}

/**
 * An adopted project Neon reports as not usable yet (zero or several
 * databases, unfinished operations, endpoint not ready). Transient: it
 * goes through the normal failure record and retry like any other error.
 */
export class ProvisioningNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningNotReadyError';
  }
}

export interface ProvisionTenantDeps {
  controlDb: ControlDb;
  neon: NeonProvisioningClient;
  /** TENANT_ENCRYPTION_KEY */
  encryptionKey: string;
  applySchema?: typeof applyTenantSchema;
}

/** The 5th delivery's failure marks the row FAILED (max_retries = 4). */
export const MAX_PROVISIONING_DELIVERIES = 5;
/** Retry delay after a failed attempt, indexed by `attempts - 1`. */
export const PROVISIONING_RETRY_DELAYS_SECONDS = [60, 300, 900, 1800];
/** The DLQ's final delivery (its max_retries = 3) fails the row regardless of the lease. */
export const DEAD_LETTER_FINAL_DELIVERY = 4;
/** Just past the 20 minute lease. */
export const DEAD_LETTER_LEASE_WAIT_SECONDS = 1260;

export function tenantProjectName(orgId: string): string {
  return `rarebooks-tenant-${orgId}`;
}

/**
 * The class of whatever was thrown. Not everything thrown is an `Error`: the
 * Neon serverless driver rejects with a WebSocket `ErrorEvent` when it can't
 * connect, so objects are named by their constructor or `toStringTag`
 * rather than lumped together as "object".
 */
export function errorClass(err: unknown): string {
  if (err instanceof Error) {
    return err.name !== 'Error' ? err.name : err.constructor.name || 'Error';
  }
  if (typeof err === 'object' && err !== null) {
    const constructorName = (err as { constructor?: { name?: unknown } })
      .constructor?.name;
    if (
      typeof constructorName === 'string' &&
      constructorName !== '' &&
      constructorName !== 'Object'
    ) {
      return constructorName;
    }
    const tag = Object.prototype.toString.call(err).slice(8, -1);
    return tag !== 'Object' ? tag : 'object';
  }
  return err === null ? 'null' : typeof err;
}

const CONNECTION_STRING_PATTERN = /postgres(ql)?:\/\/\S+/g;
const NO_DETAIL_ERROR_EVENT =
  'WebSocket error event with no message, usually a failed database connection';

/**
 * The human readable part of a thrown value, never `String(err)` on an
 * object (that gives "[object ErrorEvent]"). An `ErrorEvent` keeps its
 * detail in `message`, or in an inner `error` with its own `code`.
 */
function describeThrown(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null) {
    const { message, error } = err as { message?: unknown; error?: unknown };
    if (typeof message === 'string' && message !== '') {
      return message;
    }
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' && !error.message.includes(code)
        ? `${error.message} (${code})`
        : error.message;
    }
    return errorClass(err) === 'ErrorEvent'
      ? NO_DETAIL_ERROR_EVENT
      : 'no message';
  }
  return typeof err === 'symbol' ? 'symbol' : String(err);
}

/**
 * What gets stored in `provisioning_last_error`: the error's class, the Neon
 * HTTP status if any, and the first 200 characters of its message with any
 * connection string redacted (AC-12). Never the raw error.
 */
export function sanitizeError(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  const httpStatus = typeof status === 'number' ? ` (HTTP ${status})` : '';
  const redacted = describeThrown(err)
    .slice(0, 200)
    .replace(CONNECTION_STRING_PATTERN, '[redacted]');
  return `${errorClass(err)}${httpStatus}: ${redacted}`;
}

type ProvisioningEvent =
  | 'provisioning.ready'
  | 'provisioning.adopted_project'
  | 'provisioning.duplicate_projects'
  | 'provisioning.already_done'
  | 'provisioning.deferred_live_claim'
  | 'provisioning.claim_lost'
  | 'provisioning.attempt_failed'
  | 'provisioning.failed'
  | 'provisioning.dead_lettered';

const ERROR_EVENTS = new Set<ProvisioningEvent>([
  'provisioning.attempt_failed',
  'provisioning.failed',
  'provisioning.dead_lettered',
]);

/**
 * One JSON line per event (AC-12). Callers pass ids, counts, and delays
 * only; never a connection string, key, or raw error message.
 */
function logEvent(
  event: ProvisioningEvent,
  fields: { orgId: string; attempt: number } & Record<
    string,
    string | number | boolean | string[]
  >
): void {
  const line = JSON.stringify({ event, ...fields });
  if (ERROR_EVENTS.has(event)) {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Consumer algorithm steps 1 to 7. Throws only before the claim (the row
 * upsert) or when recording a failure itself fails; the platform then
 * redelivers, and an abandoned lease expires on its own.
 */
export async function provisionTenant(
  orgId: string,
  message: ProvisioningMessage,
  deps: ProvisionTenantDeps
): Promise<void> {
  const { controlDb } = deps;
  const claimId = message.id;
  const attempt = message.attempts;

  // 1. The row exists before any Neon call; then take the lease.
  await ensureTenantProjectRow(controlDb, orgId);
  const claimed = await claimProvisioningLease(controlDb, { orgId, claimId });

  // 2. Refused: done already, or someone else holds a live lease.
  if (!claimed) {
    const state = await getProvisioningState(controlDb, { orgId, claimId });
    if (!state) {
      throw new Error(`tenant_projects row for ${orgId} vanished after upsert`);
    }
    if (state.status === 'READY' || state.status === 'SUSPENDED') {
      message.ack();
      logEvent('provisioning.already_done', {
        orgId,
        attempt,
        status: state.status,
      });
      return;
    }
    const delaySeconds = Math.max(state.lease_remaining_seconds ?? 0, 0) + 60;
    message.retry({ delaySeconds });
    logEvent('provisioning.deferred_live_claim', {
      orgId,
      attempt,
      delaySeconds,
    });
    return;
  }

  const claimLost = () => {
    // 7. Taken over: the new holder owns the row now. Change nothing.
    message.ack();
    logEvent('provisioning.claim_lost', { orgId, attempt });
  };

  try {
    let connectionString: string;

    if (claimed.neon_project_id === '') {
      // 3. No project recorded: adopt one by name, else create it.
      const project = await findOrCreateProject(orgId, attempt, deps);
      const recorded = await recordTenantProject(controlDb, {
        orgId,
        claimId,
        neonProjectId: project.neonProjectId,
        encryptedConnectionString: await encrypt(
          project.connectionString,
          deps.encryptionKey
        ),
        region: project.region,
      });
      if (!recorded) {
        return claimLost();
      }
      connectionString = project.connectionString;
    } else {
      // 4. Recorded already (a resume, or a FAILED retry): same project.
      connectionString = await decrypt(
        claimed.connection_string,
        deps.encryptionKey
      );
    }

    await (deps.applySchema ?? applyTenantSchema)(connectionString);

    // 5. READY, fenced by the claim.
    if (!(await markTenantProjectReady(controlDb, { orgId, claimId }))) {
      return claimLost();
    }
    message.ack();
    logEvent('provisioning.ready', { orgId, attempt });
  } catch (err) {
    // 6. One fenced statement records the error and releases the lease.
    const final = attempt >= MAX_PROVISIONING_DELIVERIES;
    const recorded = await recordProvisioningFailure(controlDb, {
      orgId,
      claimId,
      error: sanitizeError(err),
      final,
    });
    if (!recorded) {
      return claimLost();
    }
    if (final) {
      message.ack();
      logEvent('provisioning.failed', {
        orgId,
        attempt,
        errorClass: errorClass(err),
      });
      return;
    }
    const delaySeconds =
      PROVISIONING_RETRY_DELAYS_SECONDS[attempt - 1] ??
      PROVISIONING_RETRY_DELAYS_SECONDS[
        PROVISIONING_RETRY_DELAYS_SECONDS.length - 1
      ];
    message.retry({ delaySeconds });
    logEvent('provisioning.attempt_failed', {
      orgId,
      attempt,
      errorClass: errorClass(err),
      delaySeconds,
    });
  }
}

/**
 * Adopt before create (AC-5): the oldest exact name match wins, every other
 * match is ledgered DUPLICATE_NAME, and only when there are none does it
 * create a project.
 */
async function findOrCreateProject(
  orgId: string,
  attempt: number,
  deps: ProvisionTenantDeps
): Promise<{
  neonProjectId: string;
  connectionString: string;
  region: string;
}> {
  const name = tenantProjectName(orgId);
  const matches = await deps.neon.findProjectsByName(name);

  if (matches.length === 0) {
    return deps.neon.createAndConnect({ name });
  }

  const [oldest, ...duplicates] = matches;
  for (const duplicate of duplicates) {
    await insertNeonProjectOrphan(deps.controlDb, {
      neonProjectId: duplicate.id,
      orgId,
      reason: 'DUPLICATE_NAME',
    });
  }
  if (duplicates.length > 0) {
    logEvent('provisioning.duplicate_projects', {
      orgId,
      attempt,
      neonProjectIds: duplicates.map((d) => d.id),
    });
  }

  const connectionString = await deps.neon.getConnectionString(oldest.id);
  logEvent('provisioning.adopted_project', {
    orgId,
    attempt,
    neonProjectId: oldest.id,
  });
  return { neonProjectId: oldest.id, connectionString, region: oldest.region };
}

/**
 * The dead letter consumer (AC-7). Its message ids differ from the
 * original's, so it never matches a claim: it waits out a live lease, then
 * marks the row FAILED, and on its own final delivery fails it regardless.
 */
export async function handleDeadLetteredProvisioning(
  orgId: string,
  message: ProvisioningMessage,
  deps: { controlDb: ControlDb }
): Promise<void> {
  const attempt = message.attempts;
  const force = attempt >= DEAD_LETTER_FINAL_DELIVERY;
  const failed = await failDeadLetteredTenantProject(deps.controlDb, {
    orgId,
    force,
  });

  if (!failed && !force) {
    const state = await getProvisioningState(deps.controlDb, {
      orgId,
      claimId: message.id,
    });
    if (state?.live_foreign_claim) {
      message.retry({ delaySeconds: DEAD_LETTER_LEASE_WAIT_SECONDS });
      logEvent('provisioning.dead_lettered', {
        orgId,
        attempt,
        outcome: 'waiting_for_lease',
        delaySeconds: DEAD_LETTER_LEASE_WAIT_SECONDS,
      });
      return;
    }
  }

  message.ack();
  logEvent('provisioning.dead_lettered', {
    orgId,
    attempt,
    // 'settled': the row was already READY, SUSPENDED, or FAILED.
    outcome: failed ? 'marked_failed' : 'settled',
  });
}
