/**
 * The Worker's `queue()` handler for tenant provisioning. Thin, like the
 * routes: it picks the consumer by queue name and hands each message to
 * custom/web/auth/handleOrganizationCreated.ts, where the logic lives.
 *
 * Both queues are bound to this one Worker per env (worker/wrangler.toml):
 * `rarebooks-provisioning[-<env>]` and its dead letter queue
 * `rarebooks-provisioning-dlq[-<env>]`. `max_batch_size = 1`, so a batch
 * is one message; the loop is only defensive.
 *
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md
 */
import {
  handleDeadLetteredProvisioning,
  provisionTenant,
  type ProvisioningMessageBody,
} from '../../custom/web/auth/handleOrganizationCreated';
import { getControlDb } from '../db/control';
import { createNeonProvisioningClient } from '../lib/neon-client';
import type { WorkerEnv } from '../types';

export function isDeadLetterQueue(queueName: string): boolean {
  return queueName.startsWith('rarebooks-provisioning-dlq');
}

function readOrgId(body: unknown): string | null {
  const orgId = (body as Partial<ProvisioningMessageBody> | null)?.orgId;
  return typeof orgId === 'string' && orgId !== '' ? orgId : null;
}

export async function queue(
  batch: MessageBatch<ProvisioningMessageBody>,
  env: WorkerEnv
): Promise<void> {
  const controlDb = getControlDb(env);
  const deadLetter = isDeadLetterQueue(batch.queue);

  for (const message of batch.messages) {
    const orgId = readOrgId(message.body);
    if (!orgId) {
      // Retrying a malformed body can never succeed. Say so once and drop it.
      console.error(
        JSON.stringify({
          event: 'provisioning.invalid_message',
          queue: batch.queue,
        })
      );
      message.ack();
      continue;
    }

    if (deadLetter) {
      await handleDeadLetteredProvisioning(orgId, message, { controlDb });
    } else {
      await provisionTenant(orgId, message, {
        controlDb,
        neon: createNeonProvisioningClient(env),
        encryptionKey: env.TENANT_ENCRYPTION_KEY,
      });
    }
  }
}
