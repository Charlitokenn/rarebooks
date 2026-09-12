/**
 * RareBooks web platform API — Cloudflare Workers, Hono.
 * Web only. Must never import Electron-only code (main/, custom/licensing/).
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md
 */
import { Hono } from 'hono';
import { clerkMiddleware } from '@clerk/hono';
import type { WorkerEnv } from './types';
import { meRoute } from './routes/me';
import { dashboardRoute } from './routes/dashboard';
import { dbRoute } from './routes/db';
import { subscriptionStatusRoute } from './routes/subscription-status';
import { organizationCreatedRoute } from './routes/webhooks/organization-created';

const app = new Hono<{ Bindings: WorkerEnv }>();

// Injects the Clerk session into context for every route below; routes that
// need it enforce it themselves via requireOrgSession (worker/middleware/clerk-auth.ts).
app.use('*', clerkMiddleware());

app.get('/api/health', (c) => c.json({ ok: true, service: 'rarebooks-web' }));

app.route('/api/me', meRoute);
app.route('/api/dashboard', dashboardRoute);
// Gated behind requireActiveSubscription inside dbRoute itself (spec 0003
// AC-3), so every route under /api/db is covered structurally.
app.route('/api/db', dbRoute);
// Deliberately un-gated (AC-8): the /billing prompt must be able to ask.
app.route('/api/subscription/status', subscriptionStatusRoute);
app.route('/webhooks/organization-created', organizationCreatedRoute);

export default app;
