/**
 * /check verify 0001+0002 (authenticated pass): real Clerk sign-in on the
 * LIVE instance (E2E_EMAIL / E2E_PASSWORD; the live instance has no magic
 * test code, so a 2FA challenge needs E2E_CODE with the emailed code), then
 * the feature-0001/0002 surface exercised over HTTP through the app's own
 * origin: /api/dashboard READY, /api/db/schema, full Party CRUD with
 * cleanup, /api/subscription/status. E2E_BASE picks the target (deployed app
 * or local dev:web:full).
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'https://app.rarebooks.cc';
const EMAIL = process.env.E2E_EMAIL ?? 'test@gmail.com';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const CODE = process.env.E2E_CODE ?? '';
const MARKER = 'VERIFY-0002-E2E Pty';

function log(...a) { console.log('[e2e]', ...a); }

function assertStatus(response, expected, label) {
  assert.equal(
    response.status,
    expected,
    `${label} returned ${response.status}: ${JSON.stringify(response.body)}`
  );
}

function assertRecord(value, label) {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be a JSON object: ${JSON.stringify(value)}`
  );
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const bodyText = () => page.evaluate(() => document.body.innerText);

  await page.goto(BASE + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const id = page.getByRole('textbox', { name: /email|phone|username/i }).first();
  await id.waitFor({ timeout: 30000 });
  await id.fill(EMAIL);
  await page.getByRole('button', { name: /continue/i }).first().click();
  await page.waitForTimeout(2500);

  // password step
  const pw = page.getByLabel(/password/i).first();
  if (await pw.count()) {
    await pw.fill(PASSWORD);
    await page.getByRole('button', { name: /continue|sign in/i }).last().click();
    await page.waitForTimeout(3000);
  }

  // possible 2FA (factor-one / client-trust) challenge: email code.
  // If E2E_CODE is set, use it. Otherwise watch E2E_CODE_FILE (default
  // /tmp/e2e-code.txt): the run stays open, the email arrives, write the
  // 6 digits to that file and the run picks it up and submits.
  if (page.url().includes('factor-one') || page.url().includes('client-trust') || (await bodyText()).includes('Check your email')) {
    log('code challenge reached; url =', page.url());
    const codeInput = page.locator('input[name="code"], input#code__code, input[maxlength="6"], input[inputmode="numeric"]').first();
    await codeInput.waitFor({ timeout: 20000 });
    let code = CODE;
    if (!code) {
      const codeFile = process.env.E2E_CODE_FILE ?? '/tmp/e2e-code.txt';
      log('WAITING_FOR_CODE: paste the emailed 6-digit code into', codeFile);
      for (let waited = 0; waited < 300 && !code; waited += 2) {
        try { code = (await import('fs')).readFileSync(codeFile, 'utf8').trim(); } catch {}
        if (!code) await page.waitForTimeout(2000);
      }
      if (!code) { log('NO_CODE after 5min; aborting run'); await browser.close(); process.exit(3); }
    }
    await codeInput.fill(code);
    await page.getByRole('button', { name: /continue|verify|attempt/i }).last().click();
    await page.waitForTimeout(3500);
    log('after code, url =', page.url());
    log('after code, body =', (await bodyText()).split('\n').filter(Boolean).slice(0, 10).join(' | '));
  }

  // Clerk session task after sign-in: choose an org if shown; otherwise
  // create one through Clerk's own UI (AC-2 provisioning leg).
  await page.waitForTimeout(1500);
  let orgActive = false;
  if (page.url().includes('choose-organization') || page.url().includes('session-tasks')) {
    const orgOption = page.locator('[role="option"], button').filter({ hasText: /verify 0607|spare|test/i }).first();
    if (await orgOption.count()) {
      await orgOption.click();
      await page.waitForTimeout(3000);
      orgActive = true;
      log('selected existing org; url =', page.url());
    }
  }
  if (!orgActive) {
    await page.goto(BASE + '/create-organization', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const nameInput = page.getByLabel(/organization name|name/i).first();
    if (await nameInput.count()) {
      await nameInput.fill('Verify 0607 Test');
      await page.getByRole('button', { name: /^create/i }).last().click();
      await page.waitForTimeout(8000);
      log('created org; url =', page.url());
    } else {
      log('no create-organization form visible; body =', (await bodyText()).split('\n').filter(Boolean).slice(0, 8).join(' | '));
    }
  }

  // ---- the actual checks ----
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  const dash = await page.textContent('body');
  assert.ok(dash?.includes('Welcome to RareBooks'), 'dashboard must show the RareBooks welcome shell');
  log('dashboard shows welcome shell: true');
  await page.screenshot({ path: '/tmp/e2e-dashboard.png' });
  const api = async (path, init) =>
    page.evaluate(
      async ({ p, i }) => {
        const r = await fetch(p, { credentials: 'include', ...i });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      { p: path, i: init ?? null }
    );
  const dashboardRes = await api('/api/dashboard');
  assertStatus(dashboardRes, 200, 'GET /api/dashboard');
  assertRecord(dashboardRes.body, 'GET /api/dashboard body');
  assert.ok(
    dashboardRes.body.status === 'PROJECT_CREATED' || dashboardRes.body.status === 'READY',
    `GET /api/dashboard returned invalid status: ${JSON.stringify(dashboardRes.body.status)}`
  );
  assert.equal(typeof dashboardRes.body.orgId, 'string', 'GET /api/dashboard must return orgId');
  assert.ok(dashboardRes.body.orgId.length > 0, 'GET /api/dashboard orgId must not be empty');
  log('GET /api/dashboard ->', JSON.stringify(dashboardRes));

  const schemaRes = await api('/api/db/schema');
  assertStatus(schemaRes, 200, 'GET /api/db/schema');
  assertRecord(schemaRes.body, 'GET /api/db/schema body');
  assertRecord(schemaRes.body.Party, 'GET /api/db/schema Party');
  assert.equal(schemaRes.body.Party.name, 'Party', 'Party schema must identify itself');
  assert.ok(Array.isArray(schemaRes.body.Party.fields), 'Party schema must include fields');
  log('GET /api/db/schema -> status', schemaRes.status, '| doctypes:', Object.keys(schemaRes.body ?? {}).length, '| hasParty:', !!schemaRes.body?.Party);

  const subscriptionRes = await api('/api/subscription/status');
  assertStatus(subscriptionRes, 200, 'GET /api/subscription/status');
  assertRecord(subscriptionRes.body, 'GET /api/subscription/status body');
  assert.equal(typeof subscriptionRes.body.status, 'string', 'subscription status must be a string');
  assert.ok(
    ['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'READ_ONLY', 'CANCELLED', 'MISSING'].includes(subscriptionRes.body.status),
    `subscription response returned invalid status: ${JSON.stringify(subscriptionRes.body.status)}`
  );
  assert.ok(Object.hasOwn(subscriptionRes.body, 'code'), 'subscription response must include code');
  assert.ok(
    [null, 'SUBSCRIPTION_INACTIVE', 'SUBSCRIPTION_READ_ONLY'].includes(subscriptionRes.body.code),
    `subscription response returned invalid code: ${JSON.stringify(subscriptionRes.body.code)}`
  );
  log('GET /api/subscription/status ->', JSON.stringify(subscriptionRes));

  const audit = { createdBy: 'e2e@test', modifiedBy: 'e2e@test', created: new Date().toISOString(), modified: new Date().toISOString() };
  const call = (method, args) => api('/api/db/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const out = {};
  let inserted = false;
  try {
    out.insert = await call('insert', ['Party', { name: MARKER, role: 'Customer', ...audit }]);
    inserted = out.insert.status === 200;
    assertStatus(out.insert, 200, 'insert Party');
    assertRecord(out.insert.body, 'insert Party body');
    assert.equal(out.insert.body.name, MARKER, 'insert must return the Party name');
    assert.equal(out.insert.body.role, 'Customer', 'insert must return the Party role');

    out.get = await call('get', ['Party', MARKER, ['name', 'role']]);
    assertStatus(out.get, 200, 'get Party');
    assertRecord(out.get.body, 'get Party body');
    assert.equal(out.get.body.name, MARKER, 'get must return the inserted Party');
    assert.equal(out.get.body.role, 'Customer', 'get must return the inserted role');

    out.getAll = await call('getAll', ['Party', { filters: { name: MARKER }, fields: ['name'] }]);
    assertStatus(out.getAll, 200, 'getAll Party');
    assert.ok(Array.isArray(out.getAll.body), 'getAll must return an array');
    assert.ok(out.getAll.body.some((row) => row?.name === MARKER), 'getAll must include the inserted Party');

    out.update = await call('update', ['Party', { name: MARKER, email: 'e2e@example.test' }]);
    assertStatus(out.update, 200, 'update Party');

    out.getAfterUpdate = await call('get', ['Party', MARKER, ['email']]);
    assertStatus(out.getAfterUpdate, 200, 'get updated Party');
    assertRecord(out.getAfterUpdate.body, 'get updated Party body');
    assert.equal(out.getAfterUpdate.body.email, 'e2e@example.test', 'update must persist the Party email');

    out.bespoke = await api('/api/db/bespoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'getLastInserted', args: ['NumberSeries'] }) });
    assertStatus(out.bespoke, 200, 'getLastInserted bespoke query');
    assert.equal(typeof out.bespoke.body, 'number', 'getLastInserted must return a number');
    assert.ok(Number.isFinite(out.bespoke.body), 'getLastInserted must return a finite number');

    out.rejectedMethod = await call('migrate', []);
    assertStatus(out.rejectedMethod, 400, 'rejected migrate method');
    assertRecord(out.rejectedMethod.body, 'rejected migrate method body');
    assert.equal(typeof out.rejectedMethod.body.error, 'string', 'rejected method must return an error');
    assert.ok(out.rejectedMethod.body.error.length > 0, 'rejected method error must not be empty');
  } finally {
    if (inserted) {
      out.delete = await call('delete', ['Party', MARKER]);
      assertStatus(out.delete, 200, 'delete Party cleanup');
      out.existsAfterDelete = await call('exists', ['Party', MARKER]);
      assertStatus(out.existsAfterDelete, 200, 'exists after Party cleanup');
      assert.equal(out.existsAfterDelete.body, false, 'cleanup must remove the inserted Party');
    }
    console.log('[e2e] CRUD:', JSON.stringify(out, null, 1));
  }
} finally {
  await browser.close();
}
