/**
 * Root-side tape tests for spec 0004's shared billing core: the ladder rung
 * table (gateDecision), the status-route code mapping (wireCodeForStatus),
 * and the plan constants both Worker and client read. No network, no
 * database — pure functions over the rung table.
 *
 * Spec: docs/specs/0004-paypal-subscriptions.md (AC-2, AC-10, AC-16)
 */
import test from 'tape';
import {
  gateDecision,
  wireCodeForStatus,
  type CallKind,
} from '../subscriptionGate';
import {
  GRACE_DAYS,
  PLANS,
  READ_ONLY_DAYS,
  TRIAL_DAYS,
  TRIAL_SEATS,
  isPlanKey,
  isPlanPeriod,
  planEnvVarName,
  planSeats,
} from '../plans';

const KINDS: CallKind[] = ['read', 'write'];

test('full access rungs pass both reads and writes', (t) => {
  for (const status of ['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE'] as const) {
    for (const kind of KINDS) {
      t.equal(
        gateDecision(status, kind),
        'allow',
        `${status} + ${kind} is allowed`
      );
    }
  }
  t.end();
});

test('READ_ONLY passes reads and refuses writes', (t) => {
  t.equal(gateDecision('READ_ONLY', 'read'), 'allow');
  t.equal(gateDecision('READ_ONLY', 'write'), 'read-only');
  t.end();
});

test('CANCELLED, MISSING, null, and UNAVAILABLE block every kind', (t) => {
  for (const status of ['CANCELLED', 'MISSING', null, 'UNAVAILABLE'] as const) {
    for (const kind of KINDS) {
      t.equal(
        gateDecision(status, kind),
        'block',
        `${String(status)} + ${kind} is blocked`
      );
    }
  }
  t.end();
});

test('wireCodeForStatus: access rungs are null, ladder blocks carry a code', (t) => {
  for (const status of ['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE'] as const) {
    t.equal(wireCodeForStatus(status), null, `${status} has no code`);
  }
  t.equal(wireCodeForStatus('READ_ONLY'), 'SUBSCRIPTION_READ_ONLY');
  t.equal(wireCodeForStatus('CANCELLED'), 'SUBSCRIPTION_INACTIVE');
  t.equal(wireCodeForStatus('MISSING'), 'SUBSCRIPTION_INACTIVE');
  t.end();
});

test('ladder windows match the spec', (t) => {
  t.equal(TRIAL_DAYS, 14);
  t.equal(GRACE_DAYS, 7);
  t.equal(READ_ONLY_DAYS, 5);
  t.equal(TRIAL_SEATS, PLANS.dfy.seats, 'the trial runs the full app');
  t.end();
});

test('plan tiers carry the sold seats and USD prices', (t) => {
  t.deepEqual(
    {
      diy: {
        seats: PLANS.diy.seats,
        monthly: PLANS.diy.priceUsd.monthly,
        yearly: PLANS.diy.priceUsd.yearly,
      },
      dfy: {
        seats: PLANS.dfy.seats,
        monthly: PLANS.dfy.priceUsd.monthly,
        yearly: PLANS.dfy.priceUsd.yearly,
      },
    },
    {
      diy: { seats: 2, monthly: 20, yearly: 204 },
      dfy: { seats: 5, monthly: 49, yearly: 500 },
    }
  );
  // The spec's "three service perks" are migration/setup, training, and
  // priority support; the fourth entry is the shared "full app for N seats"
  // line every plan card leads with.
  t.equal(
    PLANS.dfy.perks.filter((p) => !p.startsWith('The full RareBooks app'))
      .length,
    3,
    'DFY lists its three service perks'
  );
  t.ok(PLANS.diy.name && PLANS.dfy.name);
  t.end();
});

test('plan type guards accept only the sold values', (t) => {
  t.ok(isPlanKey('diy'));
  t.ok(isPlanKey('dfy'));
  t.notOk(isPlanKey('DIY'));
  t.notOk(isPlanKey('enterprise'));
  t.ok(isPlanPeriod('monthly'));
  t.ok(isPlanPeriod('yearly'));
  t.notOk(isPlanPeriod('weekly'));
  t.end();
});

test('planSeats and planEnvVarName map each tier to its PayPal plan var', (t) => {
  t.equal(planSeats('diy'), 2);
  t.equal(planSeats('dfy'), 5);
  t.equal(planEnvVarName('diy', 'monthly'), 'PAYPAL_PLAN_ID_DIY_MONTHLY');
  t.equal(planEnvVarName('diy', 'yearly'), 'PAYPAL_PLAN_ID_DIY_YEARLY');
  t.equal(planEnvVarName('dfy', 'monthly'), 'PAYPAL_PLAN_ID_DFY_MONTHLY');
  t.equal(planEnvVarName('dfy', 'yearly'), 'PAYPAL_PLAN_ID_DFY_YEARLY');
  t.end();
});
