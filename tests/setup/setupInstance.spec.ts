/**
 * Tests for src/setup/setupInstance.ts exports (spec 0009 AC-4 foundation)
 * Verifies that helper functions are properly exported for web reuse.
 */
import test from 'tape';
import * as setupModule from 'src/setup/setupInstance';

test('setupInstance exports all required helper functions', (t) => {
  // AC-4 foundation: All helpers must be exported for web to compose
  t.ok(
    typeof setupModule.createCurrencyRecords === 'function',
    'createCurrencyRecords is exported'
  );
  t.ok(
    typeof setupModule.createAccountRecords === 'function',
    'createAccountRecords is exported'
  );
  t.ok(
    typeof setupModule.updateAccountingSettings === 'function',
    'updateAccountingSettings is exported'
  );
  t.ok(
    typeof setupModule.updateSystemSettings === 'function',
    'updateSystemSettings is exported'
  );
  t.ok(
    typeof setupModule.createDefaultNumberSeries === 'function',
    'createDefaultNumberSeries is exported'
  );
  t.ok(
    typeof setupModule.updateInventorySettings === 'function',
    'updateInventorySettings is exported'
  );
  t.ok(
    typeof setupModule.completeSetup === 'function',
    'completeSetup is exported'
  );
  t.ok(
    typeof setupModule.createDiscountAccount === 'function',
    'createDiscountAccount is exported'
  );
  t.end();
});

test('exported helper functions are async', (t) => {
  // All setup helpers are async and return promises
  const helpers = [
    setupModule.createCurrencyRecords,
    setupModule.createAccountRecords,
    setupModule.updateAccountingSettings,
    setupModule.updateSystemSettings,
    setupModule.createDefaultNumberSeries,
    setupModule.updateInventorySettings,
    setupModule.completeSetup,
    setupModule.createDiscountAccount,
  ];

  helpers.forEach((helper) => {
    const result = helper({} as any);
    t.ok(
      result instanceof Promise || (result && typeof result.then === 'function'),
      `${helper.name} returns a promise-like`
    );
  });
  t.end();
});
