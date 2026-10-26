/**
 * Cloudflare Workers bindings (secrets + vars) for the RareBooks web
 * platform. Configure the secret values with `wrangler secret put <NAME>`
 * — never commit real values. See wrangler.toml for [vars] (non-secret).
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md,
 * "Configuration required"
 */
export interface WorkerEnv {
  // Tenant provisioning queue (spec 0010). A binding, not a secret: declared
  // per env in wrangler.toml, since queue bindings don't inherit across envs.
  // The body matches ProvisioningMessageBody in
  // custom/web/auth/handleOrganizationCreated.ts: orgId only, never a secret.
  PROVISIONING_QUEUE: Queue<{ orgId: string }>;

  // Clerk
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_WEBHOOK_SIGNING_SECRET: string;

  // Neon
  NEON_API_KEY: string;
  NEON_ACCOUNT_ORG_ID: string;
  CONTROL_DATABASE_URL: string;

  // Tenant connection-string encryption (added during /develop, see spec 0001)
  TENANT_ENCRYPTION_KEY: string;
}
